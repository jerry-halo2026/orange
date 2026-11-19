// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createLimiter,withBackoff} from './rate.ts';

/**
 * The limiter is the only thing standing between a sync loop and the supplier's paid endpoint, so its
 * two properties are pinned here: never more than the agreed concurrency, and never faster than the
 * agreed rate - including the pause after a burst.
 */
function fakeClock(){
  let current=0;
  const sleeps:number[]=[];
  return {
    now:()=>current,
    sleep:async(ms:number)=>{sleeps.push(ms);current+=ms;},
    sleeps,
    advance:(ms:number)=>{current+=ms;},
  };
}

test('the limiter never runs more tasks at once than its concurrency',async()=>{
  const clock=fakeClock();
  const limiter=createLimiter({concurrency:1,qps:1000,burst:10,now:clock.now,sleep:clock.sleep});
  let active=0,peak=0;
  const task=()=>async()=>{active+=1;peak=Math.max(peak,active);await Promise.resolve();active-=1;return true;};
  await Promise.all([limiter.run(task()),limiter.run(task()),limiter.run(task())]);
  assert.equal(peak,1,'one at a time by default');
  assert.equal(limiter.stats().peakConcurrency,1);

  const two=createLimiter({concurrency:2,qps:1000,burst:10,now:clock.now,sleep:clock.sleep});
  let active2=0,peak2=0;
  const task2=()=>async()=>{active2+=1;peak2=Math.max(peak2,active2);await Promise.resolve();active2-=1;return true;};
  await Promise.all([two.run(task2()),two.run(task2())]);
  assert.equal(peak2,2,'two are allowed when asked for');
});

test('the steady rate is one per second, and a burst is capped',async()=>{
  const clock=fakeClock();
  const limiter=createLimiter({qps:1,burst:1,maxConsecutive:100,now:clock.now,sleep:clock.sleep});
  const started=clock.now();
  await limiter.run(async()=>1);
  await limiter.run(async()=>2);
  assert.equal(clock.sleeps.length,1,'the second call has to wait for a token');
  assert.equal(clock.sleeps[0],1000,'exactly one second at 1 QPS');
  assert.equal(clock.now()-started>=1000,true);
});

test('after a run of consecutive calls the limiter stays quiet, and then resumes',async()=>{
  const clock=fakeClock();
  const limiter=createLimiter({qps:1000,burst:100,maxConsecutive:3,quietMs:2000,now:clock.now,sleep:clock.sleep});
  for(let index=0;index<3;index+=1)await limiter.run(async()=>index);
  assert.equal(limiter.stats().quietPeriods,1,'the third call started the quiet period');
  clock.sleeps.length=0;
  await limiter.run(async()=>4);
  assert.equal(clock.sleeps.length,1);
  assert.equal(clock.sleeps[0],2000,'the next call waits out the quiet period');
});

test('backoff waits 2/4/8/16 seconds and gives up after five attempts',async()=>{
  const clock=fakeClock();
  let calls=0;
  await assert.rejects(()=>withBackoff(async()=>{calls+=1;throw new Error('boom');},{sleep:clock.sleep}));
  assert.equal(calls,5);
  assert.deepEqual(clock.sleeps,[2000,4000,8000,16000]);
});

test('backoff returns as soon as the read succeeds',async()=>{
  const clock=fakeClock();
  let calls=0;
  const value=await withBackoff(async()=>{calls+=1;if(calls<3)throw new Error('flaky');return 'ok';},{sleep:clock.sleep});
  assert.equal(value,'ok');
  assert.equal(calls,3);
  assert.deepEqual(clock.sleeps,[2000,4000]);
});
