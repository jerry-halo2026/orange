import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { resolve, join, isAbsolute, relative } from 'node:path';
import { createProjectControlGuard, ordinaryControlPath } from './project-control-guard.mjs';

test('real Windows file-symbolic marker refuses before native callback', async () => {
 assert.equal(process.platform,'win32','this security assertion requires real Windows');
 const base=process.env.ORANGE_NATIVE_STUDIO_CI_TEMP;
 assert.equal(typeof base,'string','an explicit owned test temp is required');
 assert.equal(isAbsolute(base),true);
 const namespace=resolve('.dev/native-studio-ci'), tail=relative(namespace,base);
 assert.ok(tail && !tail.startsWith('..') && !isAbsolute(tail),'test temp must stay in the native CI namespace');
 ordinaryControlPath(base);mkdirSync(base,{recursive:true});ordinaryControlPath(base);
 const root=mkdtempSync(join(base,'file-marker-'));
 const nativeRoot=join(root,'native');mkdirSync(nativeRoot);
 const markerFile=join(root,'valid-marker.json');
 writeFileSync(markerFile,JSON.stringify({version:1,domainId:'synthetic-file-link-marker'}),{flag:'wx'});
 // A junction, conditional skip, or EPERM catch would not test the missing case.
 // Unsupported local privilege fails here, before either security assertion.
 symlinkSync(markerFile,join(nativeRoot,'.openfilm-control.json'),'file');
 const guard=createProjectControlGuard({coordinationRoot:join(root,'coordination')});
 let callbacks=0;
 await assert.rejects(guard.withNativeAccess({homes:[],roots:[nativeRoot],targets:[]},()=>{callbacks++;}),{code:'control-invalid'});
 assert.equal(callbacks,0,'invalid marker must refuse before native work');
});
