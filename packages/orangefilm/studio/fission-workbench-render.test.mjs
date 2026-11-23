// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {createServer as createHttpServer} from 'node:http';
import react from '@vitejs/plugin-react';
import {chromium} from 'playwright-core';

test('the real workbench selects a folder, starts a batch, and creates only the selected draft',{timeout:60000},async()=>{
  const root=fileURLToPath(new URL('../.dev/fission-workbench-ui/',import.meta.url));
  await mkdir(root,{recursive:true});
  const fixture=await mkdtemp(join(root,'attempt-'));
  const ui=fileURLToPath(new URL('./ui/src/',import.meta.url)),workspace=resolve(ui,'../../../../..');
  const component=join(ui,'components','FissionWorkbench.tsx').replaceAll('\\','/');
  await writeFile(join(fixture,'index.html'),'<div id="root"></div><script type="module" src="/harness.tsx"></script>');
  await writeFile(join(fixture,'harness.tsx'),[
    "import React from 'react';",
    "import {createRoot} from 'react-dom/client';",
    `import {FissionWorkbench} from '/@fs/${component}';`,
    "function Harness(){const [visible,setVisible]=React.useState(true);const [gen,setGen]=React.useState(1);return <><button onClick={()=>setVisible(!visible)}>Switch page</button><button onClick={()=>setGen(gen===1?2:1)}>Switch account</button><div hidden={!visible}><FissionWorkbench key={gen} viewActive={visible} authGeneration={gen} onOpenProject={(id)=>{(window as any).opened=id;}}/></div></>};",
    "createRoot(document.getElementById('root')!).render(<Harness/>);"
  ].join('\n'));
  const vite=await createServer({configFile:false,root:fixture,cacheDir:join(fixture,'.vite-cache'),plugins:[react()],resolve:{alias:{'@':ui},dedupe:['react','react-dom']},server:{middlewareMode:true,hmr:false,ws:false,fs:{allow:[fixture,ui,workspace]}},appType:'spa'});
  const http=createHttpServer(vite.middlewares);let browser;
  const calls=[];let selections=0,starts=0,draftPosts=0,draftChecks=0,foundRequest=false,pollAttempts=0;
  try{
    await new Promise((done,fail)=>{http.once('error',fail);http.listen(0,'127.0.0.1',done);});
    browser=await chromium.launch({headless:true,executablePath:process.env.ORANGE_TEST_BROWSER||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',args:['--use-angle=swiftshader']});
    const page=await browser.newPage({locale:'en-US'});
    await page.route('**/api/fission-local/**',async route=>{
      const req=route.request(),url=new URL(req.url()),body=req.postDataJSON();calls.push({path:url.pathname,method:req.method(),body});
      let value;
      if(url.pathname.endsWith('/select')){
        if(body?.role==='audio'){await route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({code:'fission-folder-empty',error:'C:\\private\\voice'})});return;}
        value=++selections===1?{selectionId:'selection_123456',role:'video',name:'Demo folder',groups:[{name:'01',count:3}]}:null;
      }
      else if(url.pathname.endsWith('/jobs')&&req.method()==='GET')value=foundRequest?[{jobId:'batch_123456',status:'completed',outputs:[{index:0,state:'completed',title:'first'},{index:1,state:'completed',title:'second'}]}]:[];
      else if(url.pathname.endsWith('/jobs')){
        ++starts;
        if(starts<=3){await route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'generic error',code:starts===1?'fission-scene-groups-disabled':starts===2?'fission-transition-range':'fission-job-invalid'})});return;}
        await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'connection lost'})});return;
      }
      else if(url.pathname.includes('/requests/')){foundRequest=true;value={jobId:'batch_123456',status:'running',outputs:[]};}
      else if(url.pathname.endsWith('/draft')&&req.method()==='GET'){
        if(url.pathname.endsWith('/outputs/1/draft')&&draftPosts>=2)value={status:'ready',project:{id:'native-project-1'},blockingCapabilities:['unsupported-effect'],exportReady:false,equivalenceVerified:false};
        else if(url.pathname.endsWith('/outputs/1/draft')&&draftPosts>0)value={status:++draftChecks===1?'needs-reconciliation':'not-started'};
        else value={status:'not-started'};
      }
      else if(url.pathname.endsWith('/outputs/1/draft')){
        if(++draftPosts===1){await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'connection lost'})});return;}
        value={status:'ready',project:{id:'native-project-1'},blockingCapabilities:['unsupported-effect'],exportReady:false,equivalenceVerified:false};
      }
      else if(url.pathname.endsWith('/jobs/batch_123456')&&++pollAttempts===1){await route.fulfill({status:503,contentType:'application/json',body:'{"error":"temporary failure"}'});return;}
      else value={jobId:'batch_123456',status:'completed',outputs:[{index:0,state:'completed',title:'first'},{index:1,state:'completed',title:'second'}]};
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(value)});
    });
    await page.goto(`http://127.0.0.1:${http.address().port}`);
    await page.getByText(/a test tone is used with no voice/).waitFor();
    await page.getByRole('button',{name:'Choose folder'}).first().waitFor({state:'visible'});
    await page.waitForFunction(()=>!document.querySelector('fieldset')?.disabled);
    await page.getByRole('button',{name:'Choose folder'}).first().click();
    await page.getByText('Demo folder').waitFor();
    await page.getByRole('button',{name:'Choose folder'}).first().click();
    assert.equal(await page.getByText('Demo folder').count(),1,'cancelled picker keeps previous selection');
    await page.waitForFunction(()=>[...document.querySelectorAll('button')].filter(button=>button.textContent==='Choose folder').length===5);
    await page.getByRole('button',{name:'Choose folder'}).nth(1).click();
    await page.getByText('Could not select folder: The selected folder has no usable media. Choose a folder containing the required files.').waitFor();
    assert.doesNotMatch(await page.locator('body').innerText(),/C:\\private\\voice/);
    await page.getByRole('checkbox',{name:'Use 01',exact:true}).uncheck();
    await page.getByText('Enable at least one scene group.').waitFor();
    assert.equal(await page.getByRole('button',{name:'Start batch'}).isDisabled(),true);
    assert.equal(calls.filter(x=>x.path.endsWith('/jobs')&&x.method==='POST').length,0,'no enabled scenes must not launch');
    await page.getByRole('checkbox',{name:'Use 01',exact:true}).check();
    await page.getByLabel('Count',{exact:true}).fill('2');
    await page.getByLabel('Transition seconds, 0–2; 0 disables').fill('2.05');
    await page.getByRole('button',{name:'Start batch'}).click();
    await page.getByText(/transition must be 0–2 seconds/).waitFor();
    assert.equal(calls.filter(x=>x.path.endsWith('/jobs')&&x.method==='POST').length,0,'invalid transition must not launch');
    await page.getByLabel('Transition seconds, 0–2; 0 disables').fill('2');
    await page.getByRole('button',{name:'Start batch'}).click();
    await page.getByText('Enable at least one scene group.',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('orange-fission-pending-1')),null,'known pre-claim rejection can be corrected');
    await page.getByRole('button',{name:'Start batch'}).click();
    await page.getByText('Transition duration must be between 0 and 2 seconds.',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('orange-fission-pending-1')),null,'known range rejection can be corrected');
    await page.getByRole('button',{name:'Start batch'}).click();
    await page.getByText('The batch settings are invalid. Check your selections and output settings.',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('orange-fission-pending-1')),null,'known invalid request can be corrected');
    await page.getByRole('button',{name:'Start batch'}).click();
    await page.getByText(/Batch was not confirmed/).waitFor();
    await page.getByRole('button',{name:'Retry same request'}).click();
    await page.getByText(/Batch was not confirmed/).waitFor();
    const pending=await page.evaluate(()=>sessionStorage.getItem('orange-fission-pending-1'));
    assert.match(pending,/^[a-f0-9-]{36}$/i);
    await page.getByRole('button',{name:'Switch account'}).click();
    assert.equal(await page.getByRole('button',{name:'Find batch'}).count(),0,'a different account generation cannot adopt the previous pending request');
    await page.getByRole('button',{name:'Switch account'}).click();
    await page.getByRole('button',{name:'Find batch'}).waitFor();
    await page.reload();
    await page.getByRole('button',{name:'Find batch'}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Retry same request'}).isDisabled(),true,'reload must not fabricate a new request');
    await page.getByRole('button',{name:'Find batch'}).click();
    await page.getByText('Status: Running',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Switch page'}).click();
    await page.waitForTimeout(1500);
    assert.equal(pollAttempts,0,'a hidden page must cancel the scheduled poll');
    await page.getByRole('button',{name:'Switch page'}).click();
    await page.getByText('Batch status is unavailable; retrying.').waitFor();
    await page.getByText('second · Completed',{exact:true}).waitFor({timeout:7000});
    assert.equal(pollAttempts,2,'a transient status failure must retry without another user action');
    assert.equal(await page.locator('video').count(),2);
    assert.equal(calls.filter(x=>x.path.endsWith('/draft')&&x.method==='POST').length,0,'batch must not create projects');
    await page.getByRole('button',{name:'Switch page'}).click();
    await page.getByRole('button',{name:'Switch page'}).click();
    assert.equal(await page.getByText('second · Completed',{exact:true}).count(),1,'switching pages keeps the completed batch');
    await page.getByRole('button',{name:'Create editable draft'}).nth(1).click();
    await page.getByRole('button',{name:'Check draft status'}).click();
    await page.getByText('Draft status is unconfirmed. Check it first.').waitFor();
    await page.getByRole('button',{name:'Check draft status'}).click();
    await page.getByRole('button',{name:'Create editable draft'}).nth(1).click();
    await page.getByText('Draft export readiness is not yet confirmed.').waitFor();
    await page.getByText('Equivalence with the rendered video is not yet confirmed.').waitFor();
    await page.getByText('Capabilities requiring attention: unsupported-effect').waitFor();
    await page.reload();
    await page.getByText('Draft export readiness is not yet confirmed.').waitFor();
    assert.equal(calls.filter(x=>x.path.endsWith('/draft')&&x.method==='POST').length,2,'reload must only query the existing draft');
    await page.getByRole('button',{name:'Open draft'}).click();
    await page.waitForFunction(()=>window.opened==='native-project-1');
    assert.deepEqual(calls.filter(x=>x.path.endsWith('/draft')&&x.method==='POST').map(x=>x.path),['/api/fission-local/jobs/batch_123456/outputs/1/draft','/api/fission-local/jobs/batch_123456/outputs/1/draft']);
    const attempts=calls.filter(x=>x.path.endsWith('/jobs')&&x.method==='POST');
    assert.equal(attempts.length,5);assert.deepEqual(attempts[3].body,attempts[4].body,'an uncertain start must reuse the same request id and inputs');
    assert.match(attempts[3].body.requestId,/^[a-f0-9-]{36}$/i);
    const submitted=attempts[3].body;
    assert.equal(submitted.selections.video,'selection_123456');assert.equal(submitted.job.Count,2);
    assert.equal(submitted.job.TransitionSec,2,'the upper valid transition boundary is accepted');
    assert.equal(submitted.job.SceneGroups[0].Name,'01');assert.equal(submitted.job.SceneGroups[0].UseThenDelete,false);
    assert.doesNotMatch(JSON.stringify(submitted),/[A-Z]:\\\\|VideoDir|OutDir/);
  }finally{await browser?.close();if(http.listening)await new Promise(done=>http.close(done));await vite.close();}
});

test('unconfigured service stays disabled, recovered tasks are shown, and late cancellation cannot overwrite another task',{timeout:60000},async()=>{
  const root=fileURLToPath(new URL('../.dev/fission-workbench-ui/',import.meta.url));await mkdir(root,{recursive:true});
  const fixture=await mkdtemp(join(root,'recovery-'));
  const ui=fileURLToPath(new URL('./ui/src/',import.meta.url)),workspace=resolve(ui,'../../../../..');
  const component=join(ui,'components','StandaloneWorkspace.tsx').replaceAll('\\','/');
  await writeFile(join(fixture,'index.html'),'<div id="root"></div><script type="module" src="/harness.tsx"></script>');
  await writeFile(join(fixture,'harness.tsx'),[
    "import React from 'react';", "import {createRoot} from 'react-dom/client';",
    `import {StandaloneWorkspace} from '/@fs/${component}';`,
    "const draft=[{source:'local',projectId:'project-a',path:'assets/other.mp4',title:'unrelated material sentinel',mediaKind:'video',role:'video',group:''}];",
    "createRoot(document.getElementById('root')!).render(<StandaloneWorkspace kind='fission' onHome={()=>{}} onMaterials={()=>{}} onFission={()=>{}} draft={draft} draftReady={true} draftReason={null} onDraftOperation={async()=>true} onDraftRetry={async()=>true} authGeneration={1}/>);"
  ].join('\n'));
  const vite=await createServer({configFile:false,root:fixture,cacheDir:join(fixture,'.vite-cache'),plugins:[react()],resolve:{alias:{'@':ui},dedupe:['react','react-dom']},server:{middlewareMode:true,hmr:false,ws:false,fs:{allow:[fixture,ui,workspace]}},appType:'spa'});
  const http=createHttpServer(vite.middlewares);let browser,mode='unavailable',releaseCancel,markCancel,releasePoll,markPoll,pollHeld=false;
  const held=new Promise(done=>{releaseCancel=done;}),cancelSeen=new Promise(done=>{markCancel=done;});
  const heldPoll=new Promise(done=>{releasePoll=done;}),pollSeen=new Promise(done=>{markPoll=done;});
  const a='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',b='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const batch=(jobId,status)=>({jobId,status,outputs:[],logs:[jobId===a?'first batch':'second batch']});
  try{
    await new Promise((done,fail)=>{http.once('error',fail);http.listen(0,'127.0.0.1',done);});
    browser=await chromium.launch({headless:true,executablePath:process.env.ORANGE_TEST_BROWSER||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',args:['--use-angle=swiftshader']});
    const page=await browser.newPage({locale:'en-US'});
    await page.route('**/api/fission-local/**',async route=>{
      const req=route.request(),url=new URL(req.url());let value;
      if(url.pathname.endsWith('/jobs')){
        if(mode==='unavailable'){await route.fulfill({status:503,contentType:'application/json',body:'{"error":"unavailable"}'});return;}
        if(mode==='auth'){await route.fulfill({status:403,contentType:'application/json',body:'{"error":"private content","code":"authentication-required"}'});return;}
        value=mode==='unknown'?[batch(a,'needs-reconciliation')]:mode==='subtitle'?[{...batch(a,'failed'),error:'fission-subtitle-text-required'}]:mode==='subtitle-not-applied'?[{...batch(a,'failed'),error:'fission-subtitle-not-applied'}]:mode.startsWith('code:')?[{...batch(a,'failed'),error:mode.slice(5)}]:[batch(a,'running'),batch(b,'running')];
      }else if(url.pathname.endsWith('/cancel')){markCancel();await held;value=batch(a,'cancelled');}
      else if(url.pathname.endsWith('/jobs/'+a)&&!pollHeld){pollHeld=true;markPoll();await heldPoll;value=batch(a,'completed');}
      else value=batch(url.pathname.includes(a)?a:b,'running');
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(value)}).catch(()=>{});
    });
    await page.goto(`http://127.0.0.1:${http.address().port}`);
    await page.getByText('The local batch service is not configured or unavailable.').waitFor();
    assert.equal(await page.getByText('unrelated material sentinel').count(),0,'unconsumed material selections must not be displayed as batch inputs');
    assert.equal(await page.getByRole('button',{name:'Open material center'}).count(),1);
    await page.getByText('Material center selections are not yet used by this batch. Choose local folders above.').waitFor();
    assert.equal(await page.getByRole('button',{name:'Choose folder'}).first().isDisabled(),true);
    assert.equal(await page.getByRole('button',{name:'Start batch'}).isDisabled(),true);
    mode='ready';await page.getByRole('button',{name:'Retry',exact:true}).click();
    await page.getByText('first batch',{exact:true}).waitFor();
    await pollSeen;
    await page.getByRole('button',{name:'Stop',exact:true}).click();await cancelSeen;
    await page.getByLabel('Existing batches').selectOption(b);
    await page.getByText('second batch',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Stop',exact:true}).isDisabled(),false,'B can be controlled while A cancellation is pending');
    releasePoll();releaseCancel();await page.waitForTimeout(100);
    assert.equal(await page.getByLabel('Existing batches').inputValue(),b,'late cancellation of A must not replace B');
    assert.equal(await page.getByText('second batch',{exact:true}).count(),1);
    mode='unknown';await page.reload();
    await page.getByText(/previous batch needs reconciliation/i).waitFor();
    assert.equal(await page.getByRole('button',{name:'Start batch'}).isDisabled(),true);
    mode='subtitle';await page.reload();
    await page.getByText('Subtitles are enabled, but the voice audio has no matching script.').waitFor();
    mode='subtitle-not-applied';await page.reload();
    await page.getByText('Subtitles could not be generated. Check the materials and try again.').waitFor();
    const scenarios=[
      ['fission-folder-empty','The selected folder has no usable media. Choose a folder containing the required files.','所选文件夹没有可用素材，请选择包含对应素材的文件夹。'],
      ['fission-job-invalid','The batch settings are invalid. Check your selections and output settings.','任务参数无效，请检查素材选择和输出设置。'],
      ['fission-source-invalid','The media could not be read safely. Choose the folder again and check its files.','素材无法安全读取，请重新选择文件夹并检查素材。'],
      ['fission-source-changed','The media changed during processing. Select it again and retry.','素材在处理时发生变化，请重新选择并重试。'],
      ['fission-worker-failed','The batch failed. Check the media and batch status before retrying.','混剪执行失败，请检查素材和任务状态后重试。'],
      ['fission-configuration-invalid','The local batch runtime is unavailable. Check the Fission and media tool configuration.','本地混剪运行环境不可用，请检查 Fission 和媒体工具配置。'],
      ['fission-range-invalid','The video could not be read. Refresh the batch status and retry.','无法读取该成片，请刷新任务状态后重试。'],
      ['authentication-required','Your sign-in has expired. Please sign in again.','登录已失效，请重新登录。'],
      ['C:\\private\\secret.mp4','The operation could not be completed. Check the batch status and try again.','操作未完成，请检查任务状态后重试。'],
    ];
    for(const [code,en] of scenarios){mode='code:'+code;await page.reload();await page.getByText(en,{exact:true}).waitFor();assert.doesNotMatch(await page.locator('body').innerText(),/C:\\private\\secret\.mp4/);}
    mode='auth';await page.reload();await page.getByText('Your sign-in has expired. Please sign in again.',{exact:false}).waitFor();
    await page.evaluate(()=>localStorage.setItem('openfilm.language','zh-CN'));
    for(const [code,,cn] of scenarios){mode='code:'+code;await page.reload();await page.getByText(cn,{exact:true}).waitFor();assert.doesNotMatch(await page.locator('body').innerText(),/C:\\private\\secret\.mp4/);}
    mode='auth';await page.reload();await page.getByText('登录已失效，请重新登录。',{exact:false}).waitFor();
  }finally{releasePoll?.();releaseCancel?.();await browser?.close();if(http.listening)await new Promise(done=>http.close(done));await vite.close();}
});
