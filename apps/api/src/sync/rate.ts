// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The sync rate limiter and the retry policy.
 *
 * The supplier is a paid, shared service: one steady request per second, a short burst, and a pause
 * after a run of consecutive calls. Both the pacing and the backoff live here so a caller cannot
 * accidentally "just loop faster", and so tests can drive a fake clock instead of sleeping.
 *
 * Retries are **only** for reads that are safe to repeat. Downloads and any write endpoint are never
 * retried: repeating them either costs money twice or mutates twice.
 */

export type LimiterOptions=Readonly<{
  /** Requests in flight at once. The supplier tolerates two; one is the default. */
  concurrency?:number;
  /** Steady-state rate, requests per second. */
  qps?:number;
  /** Bucket capacity: how many calls may go out back-to-back. */
  burst?:number;
  /** After this many consecutive calls the limiter stays quiet for `quietMs`. */
  maxConsecutive?:number;
  quietMs?:number;
  now?:()=>number;
  sleep?:(ms:number)=>Promise<void>;
}>;

export type LimiterStats=Readonly<{requests:number;waited:number;peakConcurrency:number;quietPeriods:number}>;

export type Limiter=Readonly<{run<T>(task:()=>Promise<T>):Promise<T>;stats():LimiterStats}>;

const defaultSleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));

export function createLimiter(options:LimiterOptions={}):Limiter {
  const concurrency=Math.max(1,Math.min(2,options.concurrency??1));
  const qps=options.qps??1;
  const burst=Math.max(1,options.burst??5);
  const maxConsecutive=Math.max(1,options.maxConsecutive??10);
  const quietMs=options.quietMs??2000;
  const now=options.now??Date.now;
  const sleep=options.sleep??defaultSleep;

  let tokens=burst,lastRefill=now(),active=0,peak=0,requests=0,waited=0,quietPeriods=0,consecutive=0,quietUntil=0;
  const queue:Array<()=>void>=[];

  const refill=()=>{
    const current=now();
    const elapsed=current-lastRefill;
    if(elapsed<=0)return;
    tokens=Math.min(burst,tokens+(elapsed/1000)*qps);
    lastRefill=current;
  };

  /** Wait until the bucket has a token and no quiet period is pending. */
  async function take():Promise<void> {
    for(;;){
      const current=now();
      if(quietUntil>current){waited+=1;await sleep(quietUntil-current);continue;}
      refill();
      if(tokens>=1){tokens-=1;return;}
      const needed=Math.ceil(((1-tokens)/qps)*1000);
      waited+=1;
      await sleep(Math.max(1,needed));
    }
  }

  async function drain():Promise<void>{
    if(active>=concurrency)return;
    const next=queue.shift();
    if(next)next();
  }

  return Object.freeze({
    run<T>(task:()=>Promise<T>):Promise<T>{
      return new Promise<T>((resolve,reject)=>{
        queue.push(()=>{
          active+=1;peak=Math.max(peak,active);
          void (async()=>{
            try{
              await take();
              requests+=1;
              consecutive+=1;
              if(consecutive>=maxConsecutive){
                consecutive=0;
                quietPeriods+=1;
                quietUntil=now()+quietMs;
              }
              resolve(await task());
            }catch(error){reject(error);}
            finally{active-=1;void drain();}
          })();
        });
        void drain();
      });
    },
    stats:()=>Object.freeze({requests,waited,peakConcurrency:peak,quietPeriods}),
  });
}

export type BackoffOptions=Readonly<{
  attempts?:number;
  baseMs?:number;
  /** Deterministic jitter source so a test can pin the sleeps. */
  jitter?:(attempt:number)=>number;
  sleep?:(ms:number)=>Promise<void>;
  /** Called before each retry with the 1-based attempt number and the delay. */
  onRetry?:(attempt:number,delayMs:number,error:unknown)=>void;
}>;

/**
 * Run a **read** with the supplier's backoff: 2s, 4s, 8s, 16s, 32s plus a jitter of at most a
 * quarter, and give up after `attempts`. Anything that mutates must not use this.
 */
export async function withBackoff<T>(task:()=>Promise<T>,options:BackoffOptions={}):Promise<T> {
  const attempts=options.attempts??5;
  const base=options.baseMs??2000;
  const jitter=options.jitter??(()=>0);
  const sleep=options.sleep??defaultSleep;
  let last:unknown;
  for(let attempt=1;attempt<=attempts;attempt+=1){
    try{return await task();}
    catch(error){
      last=error;
      if(attempt===attempts)break;
      const delay=base*2**(attempt-1)+Math.min(base/4,jitter(attempt));
      options.onRetry?.(attempt,delay,error);
      await sleep(delay);
    }
  }
  throw last;
}
