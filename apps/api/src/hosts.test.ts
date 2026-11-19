// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import test from 'node:test';
import assert from 'node:assert/strict';
import {hostEntry,hostAllowed,isHostname} from './hosts.ts';

/**
 * The raw allow-list accepts exact hostnames and `*.` suffix wildcards, matched on domain
 * boundaries. The supplier serves originals from more than one CDN name under the same registrable
 * domain, so a suffix wildcard is the only sane entry — but it must not become a substring test.
 */
test('a suffix wildcard matches subdomains and nothing that merely looks similar',async()=>{
  const entries=['*.sucaicloud.com'];
  for(const allowed of ['a.sucaicloud.com','szy-hlcxy-sucaiwang.sucaicloud.com','szy-hlcxy-sucaiwang-inner.sucaicloud.com','a.b.sucaicloud.com']){
    assert.equal(hostAllowed(allowed,entries),true,allowed);
  }
  for(const refused of [
    'evil-sucaicloud.com',            // no dot boundary
    'notsucaicloud.com',
    'sucaicloud.com.evil.com',        // suffix is not at the end
    'a.sucaicloud.com.evil.com',
    'sucaicloud.com',                 // the apex is not "some subdomain"
    'xa.sucaicloud.com.evil',
    '',
  ]){
    assert.equal(hostAllowed(refused,entries),false,refused);
  }
});

test('an exact entry still matches only itself, and an empty list allows nothing',async()=>{
  assert.equal(hostAllowed('szy-hlcxy-sucaiwang.sucaicloud.com',['szy-hlcxy-sucaiwang.sucaicloud.com']),true);
  assert.equal(hostAllowed('other.sucaicloud.com',['szy-hlcxy-sucaiwang.sucaicloud.com']),false);
  assert.equal(hostAllowed('szy-hlcxy-sucaiwang.sucaicloud.com',[]),false,'fail closed');
  assert.equal(hostAllowed('anything.test',[]),false);
});

test('only a whole leftmost label may be a wildcard',async()=>{
  for(const good of ['*.sucaicloud.com','szy.sucaicloud.com','*.a.b.test']){
    assert.equal(hostEntry(good),good,good);
  }
  for(const bad of ['su*.cai.com','*','*.*.com','*sucaicloud.com','a.*.com','*.','*..com','.sucaicloud.com','*.sucaicloud.com.','*.sucaicloud.com/x','*.sucaicloud.com:443','']){
    assert.equal(hostEntry(bad),null,String(bad));
  }
});

test('case and surrounding blanks are normalized away',async()=>{
  assert.equal(hostEntry('  *.SucaiCloud.COM '),'*.sucaicloud.com');
  assert.equal(hostAllowed('A.SUCAICLOUD.COM',['*.sucaicloud.com']),true);
  assert.equal(isHostname('a.sucaicloud.com'),true);
  assert.equal(isHostname('*.sucaicloud.com'),false);
});
