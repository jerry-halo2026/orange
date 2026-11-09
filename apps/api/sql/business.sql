-- Local reviewed prototype, NOT a Supabase migration or authority to deploy.
-- All mutations are invoked by the one trusted backend. No client-provided owner/approval authority.
BEGIN;
CREATE SCHEMA orange_business;
REVOKE ALL ON SCHEMA orange_business FROM PUBLIC,anon,authenticated;
CREATE TABLE orange_business.groups(id uuid PRIMARY KEY,revision bigint NOT NULL CHECK(revision>0),active boolean NOT NULL);
CREATE TABLE orange_business.memberships(group_id uuid REFERENCES orange_business.groups(id),subject_id uuid,revision bigint NOT NULL CHECK(revision>0),active boolean NOT NULL,not_after timestamptz,PRIMARY KEY(group_id,subject_id));
CREATE TABLE orange_business.bindings(id uuid PRIMARY KEY,subject_id uuid NOT NULL,revision bigint NOT NULL CHECK(revision>0),active boolean NOT NULL,not_after timestamptz);
CREATE TABLE orange_business.assets(id uuid PRIMARY KEY,owner_id uuid NOT NULL,source_kind text NOT NULL CHECK(source_kind IN('local','zhishang')),source_ref text NOT NULL CHECK(length(source_ref)>0),binding_id uuid REFERENCES orange_business.bindings(id),binding_revision bigint,active boolean NOT NULL, CHECK((source_kind='local' AND binding_id IS NULL AND binding_revision IS NULL) OR(source_kind='zhishang' AND binding_id IS NOT NULL AND binding_revision>0)));
CREATE TABLE orange_business.asset_versions(id uuid PRIMARY KEY,asset_id uuid NOT NULL REFERENCES orange_business.assets(id),revision bigint NOT NULL CHECK(revision>0),sha256 text NOT NULL CHECK(sha256~'^[a-f0-9]{64}$'),kind text NOT NULL CHECK(kind IN('video','still','sound')),duration_sec double precision NOT NULL CHECK(duration_sec>=0 AND duration_sec<'Infinity'::float8 AND((kind='still' AND duration_sec=0)OR(kind IN('video','sound')AND duration_sec>0))),probe_revision bigint NOT NULL CHECK(probe_revision>0),review_required boolean NOT NULL,UNIQUE(asset_id,revision));
CREATE TABLE orange_business.material_reviews(version_id uuid REFERENCES orange_business.asset_versions(id),revision bigint CHECK(revision>0),reviewer_subject uuid NOT NULL,decision text NOT NULL CHECK(decision IN('approved','rejected','withdrawn')),confirmation_ref text NOT NULL CHECK(length(confirmation_ref)>0),PRIMARY KEY(version_id,revision));
CREATE TABLE orange_business.licenses(id uuid PRIMARY KEY,version_id uuid NOT NULL REFERENCES orange_business.asset_versions(id),subject_id uuid NOT NULL,revision bigint NOT NULL CHECK(revision>0),purposes text[] NOT NULL CHECK(purposes<@ARRAY['studio','fission','export','model-input']::text[] AND cardinality(purposes)>0),not_after timestamptz,revoked boolean NOT NULL,source_ref text NOT NULL CHECK(length(source_ref)>0));
CREATE TABLE orange_business.frozen_plans(id uuid PRIMARY KEY,owner_id uuid NOT NULL,group_id uuid NOT NULL REFERENCES orange_business.groups(id),native_project_id text NOT NULL CHECK(length(native_project_id) BETWEEN 1 AND 512),film_rev text NOT NULL CHECK(film_rev~'^[a-f0-9]{16}$'),payload jsonb NOT NULL,content_key text NOT NULL CHECK(content_key~'^[a-f0-9]{64}$'),authority_snapshot jsonb NOT NULL,authority_digest text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE orange_business.claims(id uuid PRIMARY KEY,owner_id uuid NOT NULL,group_id uuid NOT NULL REFERENCES orange_business.groups(id),plan_id uuid NOT NULL UNIQUE REFERENCES orange_business.frozen_plans(id),content_key text NOT NULL,idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 120),request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),state text NOT NULL CHECK(state IN('reserved','running','unknown','cancel-requested','succeeded')),attempt_nonce uuid,cancel_requested boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),succeeded_at timestamptz,UNIQUE(group_id,content_key),UNIQUE(owner_id,idempotency_key));
-- Only definite Fission duplicate decisions. This is not a general request/audit ledger.
CREATE TABLE orange_business.fission_duplicate_requests(owner_id uuid NOT NULL,idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 120),group_id uuid NOT NULL REFERENCES orange_business.groups(id),request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),content_key text NOT NULL CHECK(content_key~'^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,idempotency_key));
CREATE TABLE orange_business.deliveries(id uuid PRIMARY KEY,claim_id uuid NOT NULL REFERENCES orange_business.claims(id),evidence_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN('video','nle')),artifact_digest text NOT NULL CHECK(artifact_digest~'^[a-f0-9]{64}$'),state text NOT NULL CHECK(state IN('verified','needs-reconciliation')),observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(claim_id,evidence_id));
CREATE INDEX ON orange_business.licenses(version_id,subject_id);
CREATE INDEX ON orange_business.frozen_plans(owner_id);

DO $$DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['groups','memberships','bindings','assets','asset_versions','material_reviews','licenses','frozen_plans','claims','fission_duplicate_requests','deliveries'] LOOP
  EXECUTE format('ALTER TABLE orange_business.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE orange_business.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON orange_business.%I FROM PUBLIC,anon,authenticated',t);
 END LOOP;
END$$;
GRANT USAGE ON SCHEMA orange_business TO service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA orange_business TO service_role;
GRANT INSERT ON orange_business.frozen_plans,orange_business.claims,orange_business.fission_duplicate_requests,orange_business.deliveries TO service_role;
GRANT UPDATE ON orange_business.claims TO service_role;
-- PostgreSQL row locks require UPDATE on at least one column. These column grants
-- only support protected business row locks; immutable-version/review triggers still reject mutation.
GRANT UPDATE(revision) ON orange_business.groups,orange_business.memberships,orange_business.bindings,orange_business.licenses,orange_business.material_reviews TO service_role;
GRANT UPDATE(probe_revision) ON orange_business.asset_versions TO service_role;
GRANT UPDATE(source_ref) ON orange_business.assets TO service_role;
-- Minimum managed Auth reads for the trusted RPC caller; no auth table/schema mutations.
GRANT USAGE ON SCHEMA auth TO service_role;
GRANT SELECT(id,user_id,not_after) ON auth.sessions TO service_role;
GRANT SELECT(id,is_anonymous,deleted_at,banned_until) ON auth.users TO service_role;

CREATE FUNCTION orange_business.immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$BEGIN RAISE EXCEPTION 'orange:immutable';END$$;
CREATE TRIGGER frozen_plan_immutable BEFORE UPDATE OR DELETE ON orange_business.frozen_plans FOR EACH ROW EXECUTE FUNCTION orange_business.immutable();
CREATE TRIGGER asset_version_immutable BEFORE UPDATE OR DELETE ON orange_business.asset_versions FOR EACH ROW EXECUTE FUNCTION orange_business.immutable();
CREATE TRIGGER review_immutable BEFORE UPDATE OR DELETE ON orange_business.material_reviews FOR EACH ROW EXECUTE FUNCTION orange_business.immutable();
CREATE TRIGGER duplicate_request_immutable BEFORE UPDATE OR DELETE ON orange_business.fission_duplicate_requests FOR EACH ROW EXECUTE FUNCTION orange_business.immutable();
CREATE TRIGGER delivery_immutable BEFORE UPDATE OR DELETE ON orange_business.deliveries FOR EACH ROW EXECUTE FUNCTION orange_business.immutable();
CREATE FUNCTION orange_business.exact(j jsonb,fields text[]) RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$BEGIN
 IF jsonb_typeof(j) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(j))<>cardinality(fields) OR NOT j?&fields THEN RAISE EXCEPTION 'orange:invalid-prepared-plan';END IF;
END$$;
CREATE FUNCTION orange_business.num(j jsonb,lo float8 DEFAULT 0,hi float8 DEFAULT 1e12) RETURNS float8 LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$DECLARE n float8;BEGIN
 IF jsonb_typeof(j) IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'orange:invalid-prepared-plan';END IF;n:=(j#>>'{}')::float8;
 IF n<lo OR n>hi OR n='NaN'::float8 THEN RAISE EXCEPTION 'orange:invalid-prepared-plan';END IF;RETURN CASE WHEN n=0 THEN 0::float8 ELSE n END;
END$$;
CREATE FUNCTION orange_business.integer(j jsonb,lo float8 DEFAULT 0,hi float8 DEFAULT 10000) RETURNS int LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$DECLARE n float8;BEGIN n:=orange_business.num(j,lo,hi);IF n<>trunc(n) THEN RAISE EXCEPTION 'orange:invalid-prepared-plan';END IF;RETURN n::int;END$$;
CREATE FUNCTION orange_business.canonical(j jsonb) RETURNS bytea LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $$DECLARE result bytea;v jsonb;k text;b bytea;n float8;BEGIN
 CASE jsonb_typeof(j)
 WHEN 'null' THEN RETURN decode('00','hex');
 WHEN 'boolean' THEN RETURN CASE WHEN j='true'::jsonb THEN decode('02','hex') ELSE decode('01','hex') END;
 WHEN 'number' THEN n:=(j#>>'{}')::float8;IF n IN('NaN'::float8,'Infinity'::float8,'-Infinity'::float8) THEN RAISE EXCEPTION 'orange:nonfinite-number';END IF;RETURN decode('03','hex')||float8send(CASE WHEN n=0 THEN 0::float8 ELSE n END);
 WHEN 'string' THEN b:=convert_to(j#>>'{}','UTF8');RETURN decode('04','hex')||int4send(octet_length(b))||b;
 WHEN 'array' THEN result:=decode('05','hex')||int4send(jsonb_array_length(j));FOR v IN SELECT value FROM jsonb_array_elements(j) WITH ORDINALITY e(value,n) ORDER BY e.n LOOP result:=result||orange_business.canonical(v);END LOOP;RETURN result;
 WHEN 'object' THEN result:=decode('06','hex')||int4send((SELECT count(*)::int FROM jsonb_object_keys(j)));FOR k IN SELECT key FROM jsonb_object_keys(j) key ORDER BY key COLLATE "C" LOOP IF k!~'^[ -~]+$' THEN RAISE EXCEPTION 'orange:nonascii-field-name';END IF;result:=result||orange_business.canonical(to_jsonb(k))||orange_business.canonical(j->k);END LOOP;RETURN result;
 ELSE RAISE EXCEPTION 'orange:invalid-prepared-plan';END CASE;
END$$;
CREATE FUNCTION orange_business.identity(p_actor uuid,p_session uuid,p_until timestamptz) RETURNS timestamptz LANGUAGE plpgsql SET search_path=pg_catalog AS $$DECLARE session_until timestamptz;BEGIN
 IF p_until IS NULL OR p_until<=clock_timestamp() THEN RAISE EXCEPTION 'orange:authentication-required';END IF;
 SELECT not_after INTO session_until FROM auth.sessions WHERE id=p_session AND user_id=p_actor;
 IF NOT FOUND OR session_until<=clock_timestamp() OR NOT EXISTS(SELECT 1 FROM auth.users WHERE id=p_actor AND NOT is_anonymous AND deleted_at IS NULL AND(banned_until IS NULL OR banned_until<=clock_timestamp())) THEN RAISE EXCEPTION 'orange:authentication-required';END IF;
 RETURN least(p_until,coalesce(session_until,p_until));
END$$;
CREATE FUNCTION orange_business.group_right(p_actor uuid,p_group uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$DECLARE g orange_business.groups%ROWTYPE;m orange_business.memberships%ROWTYPE;BEGIN
 SELECT * INTO g FROM orange_business.groups WHERE id=p_group FOR UPDATE;
 IF NOT FOUND OR NOT g.active THEN RAISE EXCEPTION 'orange:group-membership-required';END IF;
 SELECT * INTO m FROM orange_business.memberships WHERE group_id=p_group AND subject_id=p_actor FOR SHARE;
 IF NOT FOUND OR NOT m.active OR m.not_after<=clock_timestamp() THEN RAISE EXCEPTION 'orange:group-membership-required';END IF;
 RETURN jsonb_build_object('groupRevision',g.revision,'membershipRevision',m.revision,'notAfter',m.not_after);
END$$;
CREATE FUNCTION orange_business.material(p_actor uuid,p_version uuid,p_purpose text) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$DECLARE v orange_business.asset_versions%ROWTYPE;a orange_business.assets%ROWTYPE;l orange_business.licenses%ROWTYPE;b orange_business.bindings%ROWTYPE;r orange_business.material_reviews%ROWTYPE;BEGIN
 IF p_purpose NOT IN('studio','fission','export','model-input') THEN RAISE EXCEPTION 'orange:unsupported-operation';END IF;
 SELECT * INTO v FROM orange_business.asset_versions WHERE id=p_version FOR SHARE;IF NOT FOUND THEN RAISE EXCEPTION 'orange:material-unavailable';END IF;
 SELECT * INTO a FROM orange_business.assets WHERE id=v.asset_id FOR SHARE;IF NOT FOUND OR NOT a.active OR a.owner_id<>p_actor THEN RAISE EXCEPTION 'orange:material-unavailable';END IF;
 IF a.source_kind='zhishang' THEN SELECT * INTO b FROM orange_business.bindings WHERE id=a.binding_id FOR SHARE;IF NOT FOUND OR b.subject_id<>p_actor OR NOT b.active OR b.revision<>a.binding_revision OR b.not_after<=clock_timestamp() THEN RAISE EXCEPTION 'orange:material-unavailable';END IF;END IF;
 SELECT * INTO l FROM orange_business.licenses WHERE version_id=v.id AND subject_id=p_actor AND NOT revoked AND p_purpose=ANY(purposes) AND(not_after IS NULL OR not_after>clock_timestamp()) ORDER BY not_after DESC NULLS FIRST,revision DESC LIMIT 1 FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'orange:material-unavailable';END IF;
 IF v.review_required THEN SELECT * INTO r FROM orange_business.material_reviews WHERE version_id=v.id ORDER BY revision DESC LIMIT 1 FOR SHARE;IF NOT FOUND OR r.decision<>'approved' THEN RAISE EXCEPTION 'orange:material-unavailable';END IF;END IF;
 RETURN jsonb_build_object('versionId',v.id,'contentSha256',v.sha256,'kind',v.kind,'durationSec',v.duration_sec,'probeRevision',v.probe_revision,'licenseId',l.id,'licenseRevision',l.revision,'notAfter',least(l.not_after,b.not_after),'reviewRevision',r.revision,'bindingRevision',b.revision);
END$$;

CREATE FUNCTION orange_business.content_parts(p jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$DECLARE materials jsonb;seen uuid[]:='{}';used uuid[]:='{}';s jsonb;c jsonb;m jsonb;a jsonb;q jsonb;t jsonb;visuals jsonb:='[]';tracks jsonb:='[]';cues jsonb:='[]';caption jsonb:='null';transition jsonb:='null';duration float8;w int;h int;d int;ordinal int:=-1;ord int;f float8;e float8;at_sec float8;speed float8;last_end float8:=0;id uuid;part jsonb;music boolean:=false;BEGIN
 PERFORM orange_business.exact(p,ARRAY['version','projectId','filmRev','job','durationSec','aspect','fps','materials','scenes','audio','captions','transition']);
 IF p->'version'<>'1'::jsonb OR jsonb_typeof(p->'filmRev')<>'string' OR jsonb_typeof(p->'projectId')<>'string' OR length(p->>'projectId') NOT BETWEEN 1 AND 512 OR p->>'filmRev'!~'^[a-f0-9]{16}$' OR jsonb_typeof(p->'job')<>'object' OR jsonb_typeof(p->'job'->'VideoDir')<>'string' THEN RAISE EXCEPTION 'orange:invalid-prepared-plan';END IF;
 duration:=orange_business.num(p->'durationSec',1e-300);w:=orange_business.integer(p->'aspect'->0,1,16384);h:=orange_business.integer(p->'aspect'->1,1,16384);d:=gcd(w,h);w:=w/d;h:=h/d;
 IF jsonb_typeof(p->'aspect')<>'array' OR jsonb_array_length(p->'aspect')<>2 OR orange_business.num(p->'job'->'OutWidth',1,16384)/orange_business.num(p->'job'->'OutHeight',1,16384)<>w::float8/h OR p->'job'->'OutFps'<>p->'fps' OR orange_business.num(p->'fps',1,240)<>trunc(orange_business.num(p->'fps',1,240)) THEN RAISE EXCEPTION 'orange:invalid-prepared-plan';END IF;
 IF jsonb_typeof(p->'materials')<>'array' OR jsonb_array_length(p->'materials') NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'orange:invalid-prepared-plan';END IF;materials:=p->'materials';
 FOR m IN SELECT value FROM jsonb_array_elements(materials) LOOP
  PERFORM orange_business.exact(m,ARRAY['versionId','contentSha256','kind','durationSec']);id:=(m->>'versionId')::uuid;IF id=ANY(seen) OR m->>'contentSha256'!~'^[a-f0-9]{64}$' OR m->>'kind' NOT IN('video','still','sound') THEN RAISE EXCEPTION 'orange:invalid-prepared-plan';END IF;seen:=array_append(seen,id);IF m->>'kind'='still' THEN IF orange_business.num(m->'durationSec')<>0 THEN RAISE EXCEPTION 'orange:invalid-prepared-plan';END IF;ELSE IF orange_business.num(m->'durationSec')<=0 THEN RAISE EXCEPTION 'orange:invalid-prepared-plan';END IF;END IF;
 END LOOP;
 IF jsonb_typeof(p->'scenes')<>'array' OR jsonb_array_length(p->'scenes')>10000 THEN RAISE EXCEPTION 'orange:invalid-prepared-plan';END IF;
 FOR s IN SELECT value FROM jsonb_array_elements(p->'scenes') LOOP
  PERFORM orange_business.exact(s,ARRAY['ordinal','name','clips']);ord:=orange_business.integer(s->'ordinal',0,10000);IF ord<=ordinal OR jsonb_typeof(s->'name')<>'string' OR jsonb_typeof(s->'clips')<>'array' THEN RAISE EXCEPTION 'orange:invalid-prepared-plan';END IF;ordinal:=ord;
  FOR c IN SELECT value FROM jsonb_array_elements(s->'clips') LOOP
   PERFORM orange_business.exact(c,ARRAY['versionId','fromSec','toSec','atSec','speed','hflip','framing']);id:=(c->>'versionId')::uuid;SELECT value INTO m FROM jsonb_array_elements(materials) WHERE(value->>'versionId')::uuid=id;IF NOT FOUND OR m->>'kind' NOT IN('video','still') THEN RAISE EXCEPTION 'orange:invalid-prepared-plan';END IF;used:=array_append(used,id);
   f:=orange_business.num(c->'fromSec');e:=orange_business.num(c->'toSec');at_sec:=orange_business.num(c->'atSec');speed:=orange_business.num(c->'speed',0.1,100);
   IF e<=f OR (m->>'kind'<>'still' AND e>orange_business.num(m->'durationSec')) OR(m->>'kind'='still' AND f<>0) OR at_sec<last_end-1e-9 OR at_sec+(e-f)/speed>duration+1e-9 OR jsonb_typeof(c->'hflip')<>'boolean' OR c->>'framing' NOT IN('cover-center','contain-center') THEN RAISE EXCEPTION 'orange:invalid-prepared-plan';END IF;last_end:=at_sec+(e-f)/speed;
   visuals:=visuals||jsonb_build_array(jsonb_build_array(m->>'contentSha256',m->>'kind',f,e,at_sec,speed,c->'hflip',c->>'framing'));
  END LOOP;
 END LOOP;IF jsonb_array_length(visuals)=0 THEN RAISE EXCEPTION 'orange:invalid-prepared-plan';END IF;
 PERFORM orange_business.exact(p->'audio',ARRAY['voice','music','postmix']);
 FOREACH music IN ARRAY ARRAY[false,true] LOOP
  a:=p->'audio'->CASE WHEN music THEN 'music' ELSE 'voice' END;
  IF music AND a='null'::jsonb THEN tracks:=tracks||jsonb_build_array(NULL);CONTINUE;END IF;
  PERFORM orange_business.exact(a,ARRAY['versionId','fromSec','toSec','volume','loop']);id:=(a->>'versionId')::uuid;SELECT value INTO m FROM jsonb_array_elements(materials) WHERE(value->>'versionId')::uuid=id;IF NOT FOUND OR m->>'kind'<>'sound' THEN RAISE EXCEPTION 'orange:invalid-prepared-plan';END IF;used:=array_append(used,id);
  f:=orange_business.num(a->'fromSec');e:=orange_business.num(a->'toSec');IF e<=f OR e>orange_business.num(m->'durationSec') OR jsonb_typeof(a->'loop')<>'boolean' OR(NOT music AND a->'loop'<>'false'::jsonb) THEN RAISE EXCEPTION 'orange:invalid-prepared-plan';END IF;
  tracks:=tracks||jsonb_build_array(jsonb_build_array(m->>'contentSha256',f,e,orange_business.num(a->'volume',0,2),a->'loop'));
 END LOOP;
 PERFORM orange_business.exact(p->'audio'->'postmix',ARRAY['kind','integratedLUFS','truePeakDBTP','loudnessRangeLU']);IF p->'audio'->'postmix'<>jsonb_build_object('kind','loudnorm','integratedLUFS',-14,'truePeakDBTP',-1.5,'loudnessRangeLU',11) THEN RAISE EXCEPTION 'orange:invalid-prepared-plan';END IF;
 IF p->'captions'<>'null'::jsonb THEN
  PERFORM orange_business.exact(p->'captions',ARRAY['style','cues']);last_end:=0;
  FOR q IN SELECT value FROM jsonb_array_elements(p->'captions'->'cues') LOOP PERFORM orange_business.exact(q,ARRAY['fromSec','toSec','text']);f:=orange_business.num(q->'fromSec');e:=orange_business.num(q->'toSec');IF f<last_end OR e<=f OR e>duration OR jsonb_typeof(q->'text')<>'string' THEN RAISE EXCEPTION 'orange:invalid-prepared-plan';END IF;last_end:=e;cues:=cues||jsonb_build_array(jsonb_build_array(f,e,q->>'text'));END LOOP;caption:=jsonb_build_array(p->'captions'->>'style',cues);
 ELSIF p->'job'->'SubtitleEnabled'='true'::jsonb THEN RAISE EXCEPTION 'orange:subtitle-not-prepared';END IF;
 IF p->'transition'<>'null'::jsonb THEN t:=p->'transition';PERFORM orange_business.exact(t,ARRAY['name','durationSec','shaderSha256']);IF t->>'shaderSha256'!~'^[a-f0-9]{64}$' OR jsonb_typeof(t->'name')<>'string' THEN RAISE EXCEPTION 'orange:invalid-prepared-plan';END IF;transition:=jsonb_build_array(t->>'name',orange_business.num(t->'durationSec',1e-300,duration),t->>'shaderSha256');
 ELSIF coalesce((p->'job'->>'TransitionSec')::float8,0)>0 THEN RAISE EXCEPTION 'orange:transition-not-prepared';END IF;
 IF(SELECT count(DISTINCT x) FROM unnest(used)x)<>cardinality(seen) THEN RAISE EXCEPTION 'orange:dependency-closure-mismatch';END IF;
 RETURN jsonb_build_array('orange-content',1,w,h,p->'fps',duration,visuals,tracks->0,tracks->1,jsonb_build_array('loudnorm',-14,-1.5,11),caption,transition);
END$$;
CREATE FUNCTION orange_business.content_key(p jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$SELECT encode(sha256(orange_business.canonical(orange_business.content_parts(p))),'hex')$$;

CREATE FUNCTION orange_business.plan_rights(p_actor uuid,p_group uuid,p_payload jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$DECLARE group_right jsonb;rights jsonb:='[]';m jsonb;current_right jsonb;BEGIN
 group_right:=orange_business.group_right(p_actor,p_group);
 FOR m IN SELECT value FROM jsonb_array_elements(p_payload->'materials') ORDER BY(value->>'versionId')::uuid LOOP
  current_right:=orange_business.material(p_actor,(m->>'versionId')::uuid,'fission');
  IF current_right->>'contentSha256'<>m->>'contentSha256' OR current_right->>'kind'<>m->>'kind' OR(current_right->>'durationSec')::float8<>(m->>'durationSec')::float8 THEN RAISE EXCEPTION 'orange:material-version-mismatch';END IF;
  rights:=rights||jsonb_build_array(current_right);
 END LOOP;
 RETURN jsonb_build_object('group',group_right,'materials',rights);
END$$;
CREATE FUNCTION orange_business.claim_access(p_actor uuid,p_claim uuid) RETURNS orange_business.claims LANGUAGE plpgsql SET search_path=pg_catalog AS $$DECLARE c orange_business.claims%ROWTYPE;p orange_business.frozen_plans%ROWTYPE;r jsonb;BEGIN
 SELECT * INTO c FROM orange_business.claims WHERE id=p_claim AND owner_id=p_actor FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'orange:not-found';END IF;
 SELECT * INTO p FROM orange_business.frozen_plans WHERE id=c.plan_id;r:=orange_business.plan_rights(p_actor,c.group_id,p.payload);
 IF r<>p.authority_snapshot THEN RAISE EXCEPTION 'orange:stale-authorization';END IF;RETURN c;
END$$;
CREATE FUNCTION orange_business.reply(c orange_business.claims) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$SELECT jsonb_build_object('claimId',c.id,'planId',c.plan_id,'status',c.state,'contentKey',c.content_key,'historyCount',CASE WHEN c.state='succeeded' THEN 1 ELSE 0 END,'executionReady',false,'frozenPlan',(SELECT payload FROM orange_business.frozen_plans WHERE id=c.plan_id AND owner_id=c.owner_id))$$;

CREATE FUNCTION public.orange_resolve_materials(p_actor uuid,p_session uuid,p_until timestamptz,p_ids uuid[],p_purpose text) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$DECLARE result jsonb:='[]';id uuid;auth_until timestamptz;BEGIN
 auth_until:=orange_business.identity(p_actor,p_session,p_until);IF cardinality(p_ids) NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'orange:invalid-input';END IF;
 FOREACH id IN ARRAY p_ids LOOP result:=result||jsonb_build_array(orange_business.material(p_actor,id,p_purpose));END LOOP;
 -- Rights calls above may wait for row locks; an earlier managed-session cutoff is never extended here.
 auth_until:=least(auth_until,orange_business.identity(p_actor,p_session,p_until));
 SELECT coalesce(jsonb_agg(e.value||jsonb_build_object('authNotAfter',auth_until) ORDER BY e.ordinal),'[]'::jsonb) INTO result FROM jsonb_array_elements(result) WITH ORDINALITY e(value,ordinal);
 RETURN result;
END$$;
CREATE FUNCTION orange_business.idempotency_input(p_key text,p_hash text) RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$BEGIN IF p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 120 OR p_hash IS NULL OR p_hash!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'orange:invalid-input';END IF;END$$;
CREATE FUNCTION public.orange_preflight(p_actor uuid,p_session uuid,p_until timestamptz,p_group uuid,p_key text,p_request_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$DECLARE c orange_business.claims%ROWTYPE;d orange_business.fission_duplicate_requests%ROWTYPE;BEGIN
 PERFORM orange_business.identity(p_actor,p_session,p_until);PERFORM orange_business.idempotency_input(p_key,p_request_hash);PERFORM pg_advisory_xact_lock(hashtextextended(p_actor::text||':'||p_key,0));PERFORM orange_business.group_right(p_actor,p_group);
 SELECT * INTO d FROM orange_business.fission_duplicate_requests WHERE owner_id=p_actor AND idempotency_key=p_key;
 IF FOUND THEN IF d.request_hash<>p_request_hash OR d.group_id<>p_group THEN RAISE EXCEPTION 'orange:idempotency-conflict';END IF;PERFORM orange_business.identity(p_actor,p_session,p_until);RETURN jsonb_build_object('status','duplicate');END IF;
 SELECT * INTO c FROM orange_business.claims WHERE owner_id=p_actor AND idempotency_key=p_key;
 IF FOUND THEN IF c.request_hash<>p_request_hash OR c.group_id<>p_group THEN RAISE EXCEPTION 'orange:idempotency-conflict';END IF;PERFORM orange_business.claim_access(p_actor,c.id);PERFORM orange_business.identity(p_actor,p_session,p_until);RETURN orange_business.reply(c);END IF;
 PERFORM orange_business.identity(p_actor,p_session,p_until);RETURN jsonb_build_object('status','prepare-required');
END$$;
CREATE FUNCTION public.orange_freeze_claim(p_actor uuid,p_session uuid,p_until timestamptz,p_group uuid,p_key text,p_request_hash text,p_plan jsonb,p_content_key text) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$DECLARE c orange_business.claims%ROWTYPE;d orange_business.fission_duplicate_requests%ROWTYPE;rights jsonb;key text;plan_id uuid;BEGIN
 PERFORM orange_business.identity(p_actor,p_session,p_until);PERFORM orange_business.idempotency_input(p_key,p_request_hash);
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor::text||':'||p_key,0));PERFORM orange_business.group_right(p_actor,p_group);
 SELECT * INTO d FROM orange_business.fission_duplicate_requests WHERE owner_id=p_actor AND idempotency_key=p_key;
 IF FOUND THEN IF d.request_hash<>p_request_hash OR d.group_id<>p_group THEN RAISE EXCEPTION 'orange:idempotency-conflict';END IF;PERFORM orange_business.identity(p_actor,p_session,p_until);RETURN jsonb_build_object('status','duplicate');END IF;
 SELECT * INTO c FROM orange_business.claims WHERE owner_id=p_actor AND idempotency_key=p_key;
 IF FOUND THEN IF c.request_hash<>p_request_hash OR c.group_id<>p_group THEN RAISE EXCEPTION 'orange:idempotency-conflict';END IF;PERFORM orange_business.claim_access(p_actor,c.id);PERFORM orange_business.identity(p_actor,p_session,p_until);RETURN orange_business.reply(c);END IF;
 key:=orange_business.content_key(p_plan);IF p_content_key IS NULL OR key<>p_content_key THEN RAISE EXCEPTION 'orange:content-key-mismatch';END IF;rights:=orange_business.plan_rights(p_actor,p_group,p_plan);
 IF EXISTS(SELECT 1 FROM orange_business.claims WHERE group_id=p_group AND content_key=key) THEN
  INSERT INTO orange_business.fission_duplicate_requests(owner_id,idempotency_key,group_id,request_hash,content_key) VALUES(p_actor,p_key,p_group,p_request_hash,key);
  PERFORM orange_business.identity(p_actor,p_session,p_until);RETURN jsonb_build_object('status','duplicate');
 END IF;
 plan_id:=gen_random_uuid();INSERT INTO orange_business.frozen_plans VALUES(plan_id,p_actor,p_group,p_plan->>'projectId',p_plan->>'filmRev',p_plan,key,rights,encode(sha256(orange_business.canonical(rights)),'hex'),clock_timestamp());
 INSERT INTO orange_business.claims(id,owner_id,group_id,plan_id,content_key,idempotency_key,request_hash,state) VALUES(gen_random_uuid(),p_actor,p_group,plan_id,key,p_key,p_request_hash,'reserved') RETURNING * INTO c;
 PERFORM orange_business.identity(p_actor,p_session,p_until);RETURN orange_business.reply(c);
END$$;
CREATE FUNCTION public.orange_claim_status(p_actor uuid,p_session uuid,p_until timestamptz,p_claim uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$DECLARE c orange_business.claims%ROWTYPE;BEGIN PERFORM orange_business.identity(p_actor,p_session,p_until);c:=orange_business.claim_access(p_actor,p_claim);PERFORM orange_business.identity(p_actor,p_session,p_until);RETURN orange_business.reply(c);END$$;
CREATE FUNCTION public.orange_start_attempt(p_actor uuid,p_session uuid,p_until timestamptz,p_claim uuid,p_nonce uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$DECLARE c orange_business.claims%ROWTYPE;BEGIN
 PERFORM orange_business.identity(p_actor,p_session,p_until);c:=orange_business.claim_access(p_actor,p_claim);
 IF c.state='running' AND c.attempt_nonce=p_nonce THEN PERFORM orange_business.identity(p_actor,p_session,p_until);RETURN orange_business.reply(c);END IF;IF c.state<>'reserved' OR p_nonce IS NULL THEN RAISE EXCEPTION 'orange:attempt-reconciliation-required';END IF;
 UPDATE orange_business.claims SET state='running',attempt_nonce=p_nonce,updated_at=clock_timestamp() WHERE id=c.id RETURNING * INTO c;PERFORM orange_business.identity(p_actor,p_session,p_until);RETURN orange_business.reply(c);
END$$;
CREATE FUNCTION public.orange_cancel_claim(p_actor uuid,p_session uuid,p_until timestamptz,p_claim uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$DECLARE c orange_business.claims%ROWTYPE;BEGIN
 PERFORM orange_business.identity(p_actor,p_session,p_until);c:=orange_business.claim_access(p_actor,p_claim);
 IF c.state<>'succeeded' THEN UPDATE orange_business.claims SET cancel_requested=true,state='cancel-requested',updated_at=clock_timestamp() WHERE id=c.id RETURNING * INTO c;END IF;PERFORM orange_business.identity(p_actor,p_session,p_until);RETURN orange_business.reply(c);
END$$;
CREATE FUNCTION public.orange_mark_unknown(p_actor uuid,p_session uuid,p_until timestamptz,p_claim uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$DECLARE c orange_business.claims%ROWTYPE;BEGIN
 PERFORM orange_business.identity(p_actor,p_session,p_until);c:=orange_business.claim_access(p_actor,p_claim);
 IF c.state<>'succeeded' THEN UPDATE orange_business.claims SET state='unknown',updated_at=clock_timestamp() WHERE id=c.id RETURNING * INTO c;END IF;PERFORM orange_business.identity(p_actor,p_session,p_until);RETURN orange_business.reply(c);
END$$;
CREATE FUNCTION public.orange_record_delivery(p_actor uuid,p_session uuid,p_until timestamptz,p_claim uuid,p_evidence uuid,p_kind text,p_content_key text,p_digest text) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$DECLARE c orange_business.claims%ROWTYPE;d orange_business.deliveries%ROWTYPE;BEGIN
 PERFORM orange_business.identity(p_actor,p_session,p_until);c:=orange_business.claim_access(p_actor,p_claim);
 IF c.content_key<>p_content_key OR p_kind NOT IN('video','nle') OR p_digest!~'^[a-f0-9]{64}$' OR c.attempt_nonce IS NULL THEN RAISE EXCEPTION 'orange:invalid-delivery';END IF;
 SELECT * INTO d FROM orange_business.deliveries WHERE claim_id=c.id AND evidence_id=p_evidence;
 IF FOUND THEN IF d.kind<>p_kind OR d.artifact_digest<>p_digest THEN RAISE EXCEPTION 'orange:idempotency-conflict';END IF;PERFORM orange_business.identity(p_actor,p_session,p_until);RETURN orange_business.reply(c);END IF;
 INSERT INTO orange_business.deliveries(id,claim_id,evidence_id,kind,artifact_digest,state) VALUES(gen_random_uuid(),c.id,p_evidence,p_kind,p_digest,CASE WHEN c.cancel_requested THEN 'needs-reconciliation' ELSE 'verified' END);
 UPDATE orange_business.claims SET state=CASE WHEN cancel_requested THEN 'unknown' ELSE 'succeeded' END,succeeded_at=CASE WHEN cancel_requested THEN succeeded_at ELSE coalesce(succeeded_at,clock_timestamp()) END,updated_at=clock_timestamp() WHERE id=c.id RETURNING * INTO c;
 PERFORM orange_business.identity(p_actor,p_session,p_until);RETURN orange_business.reply(c);
END$$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA orange_business FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA orange_business TO service_role;
DO $$DECLARE f regprocedure;BEGIN FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=ANY(ARRAY['orange_resolve_materials','orange_preflight','orange_freeze_claim','orange_claim_status','orange_start_attempt','orange_cancel_claim','orange_mark_unknown','orange_record_delivery']) LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f);EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f);END LOOP;END$$;
-- Local byte ingestion records are not licenses, reviews, or reusable hash grants.
CREATE TABLE orange_business.material_ingestions(
 owner_id uuid NOT NULL,environment_id text NOT NULL,request_key text NOT NULL CHECK(length(request_key) BETWEEN 1 AND 120),request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
 asset_id uuid NOT NULL UNIQUE,version_id uuid NOT NULL UNIQUE,locator_id uuid NOT NULL UNIQUE,file_name text NOT NULL CHECK(file_name~'^source\.[a-z0-9]{1,8}$'),original_name text NOT NULL,
 sha256 text NOT NULL CHECK(sha256~'^[a-f0-9]{64}$'),byte_length bigint NOT NULL CHECK(byte_length>0),file_identity jsonb NOT NULL,review_required boolean NOT NULL,
 state text NOT NULL CHECK(state IN('preparing','registered')),probe jsonb,kind text,duration_sec float8,probe_revision bigint,PRIMARY KEY(owner_id,request_key));
ALTER TABLE orange_business.material_ingestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE orange_business.material_ingestions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON orange_business.material_ingestions FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON orange_business.material_ingestions TO service_role;
GRANT UPDATE(state,probe,kind,duration_sec,probe_revision) ON orange_business.material_ingestions TO service_role;
GRANT INSERT ON orange_business.assets,orange_business.asset_versions TO service_role;
CREATE FUNCTION orange_business.ingestion_reply(r orange_business.material_ingestions) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('subjectId',r.owner_id,'environmentId',r.environment_id,'requestHash',r.request_hash,'assetId',r.asset_id,'versionId',r.version_id,'locatorId',r.locator_id,'fileName',r.file_name,'name',r.original_name,'sha256',r.sha256,'byteLength',r.byte_length,'identity',r.file_identity,'reviewRequired',r.review_required,'status',r.state,'kind',r.kind,'durationSec',r.duration_sec,'probeRevision',r.probe_revision,'probe',r.probe);
$$;
CREATE FUNCTION public.orange_begin_material(p_actor uuid,p_session uuid,p_until timestamptz,p_environment text,p_key text,p_payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE r orange_business.material_ingestions%ROWTYPE;h text;BEGIN
 PERFORM orange_business.identity(p_actor,p_session,p_until);
 IF p_environment IS NULL OR length(p_environment) NOT BETWEEN 1 AND 1024 OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 120 THEN RAISE EXCEPTION 'orange:invalid-input';END IF;
 PERFORM orange_business.exact(p_payload,ARRAY['assetId','versionId','locatorId','fileName','name','sha256','byteLength','identity','requestHash','reviewRequired']);
 PERFORM orange_business.exact(p_payload->'identity',ARRAY['dev','ino','size','mtimeNs','ctimeNs','nlink']);
 IF p_payload->>'fileName'!~'^source\.[a-z0-9]{1,8}$' OR length(p_payload->>'name') NOT BETWEEN 1 AND 128 OR p_payload->>'sha256'!~'^[a-f0-9]{64}$' OR jsonb_typeof(p_payload->'reviewRequired')<>'boolean' OR orange_business.num(p_payload->'byteLength',1,536870912)<>trunc(orange_business.num(p_payload->'byteLength',1,536870912)) OR p_payload->'identity'->>'nlink'<>'1' OR (p_payload->'identity'->>'size')::bigint<>(p_payload->>'byteLength')::bigint THEN RAISE EXCEPTION 'orange:invalid-input';END IF;
 h:=encode(sha256(orange_business.canonical(jsonb_build_object('name',p_payload->'name','sha256',p_payload->'sha256','byteLength',p_payload->'byteLength','reviewRequired',p_payload->'reviewRequired'))),'hex');
 IF p_payload->>'requestHash' IS DISTINCT FROM h THEN RAISE EXCEPTION 'orange:invalid-input';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('material:'||p_actor::text||':'||p_key,0));
 SELECT * INTO r FROM orange_business.material_ingestions WHERE owner_id=p_actor AND request_key=p_key FOR UPDATE;
 IF FOUND THEN IF r.environment_id<>p_environment OR r.request_hash<>h THEN RAISE EXCEPTION 'orange:idempotency-conflict';END IF;PERFORM orange_business.identity(p_actor,p_session,p_until);RETURN orange_business.ingestion_reply(r)||jsonb_build_object('created',false);END IF;
 INSERT INTO orange_business.material_ingestions VALUES(p_actor,p_environment,p_key,h,(p_payload->>'assetId')::uuid,(p_payload->>'versionId')::uuid,(p_payload->>'locatorId')::uuid,p_payload->>'fileName',p_payload->>'name',p_payload->>'sha256',(p_payload->>'byteLength')::bigint,p_payload->'identity',(p_payload->>'reviewRequired')::boolean,'preparing',NULL,NULL,NULL,NULL) RETURNING * INTO r;
 PERFORM orange_business.identity(p_actor,p_session,p_until);RETURN orange_business.ingestion_reply(r)||jsonb_build_object('created',true);
END$$;
CREATE FUNCTION public.orange_finish_material(p_actor uuid,p_session uuid,p_until timestamptz,p_environment text,p_key text,p_hash text,p_result jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE r orange_business.material_ingestions%ROWTYPE;k text;d float8;BEGIN
 PERFORM orange_business.identity(p_actor,p_session,p_until);PERFORM orange_business.exact(p_result,ARRAY['kind','durationSec','probeRevision','probe']);
 k:=p_result->>'kind';d:=orange_business.num(p_result->'durationSec',0,1e12);
 IF k NOT IN('video','still','sound') OR (k='still' AND d<>0) OR(k<>'still' AND d<=0) OR orange_business.integer(p_result->'probeRevision',1,1e6)<>1 OR jsonb_typeof(p_result->'probe')<>'object' THEN RAISE EXCEPTION 'orange:invalid-input';END IF;
 SELECT * INTO r FROM orange_business.material_ingestions WHERE owner_id=p_actor AND request_key=p_key FOR UPDATE;
 IF NOT FOUND OR r.environment_id<>p_environment OR r.request_hash<>p_hash THEN RAISE EXCEPTION 'orange:idempotency-conflict';END IF;
 IF r.state='registered' THEN IF r.kind<>k OR r.duration_sec<>d OR r.probe<>p_result->'probe' THEN RAISE EXCEPTION 'orange:idempotency-conflict';END IF;PERFORM orange_business.identity(p_actor,p_session,p_until);RETURN orange_business.ingestion_reply(r);END IF;
 INSERT INTO orange_business.assets(id,owner_id,source_kind,source_ref,active) VALUES(r.asset_id,p_actor,'local','local:'||r.locator_id::text,true);
 INSERT INTO orange_business.asset_versions(id,asset_id,revision,sha256,kind,duration_sec,probe_revision,review_required) VALUES(r.version_id,r.asset_id,1,r.sha256,k,d,1,r.review_required);
 UPDATE orange_business.material_ingestions SET state='registered',kind=k,duration_sec=d,probe_revision=1,probe=p_result->'probe' WHERE owner_id=p_actor AND request_key=p_key RETURNING * INTO r;
 PERFORM orange_business.identity(p_actor,p_session,p_until);RETURN orange_business.ingestion_reply(r);
END$$;
CREATE FUNCTION public.orange_locate_material(p_actor uuid,p_session uuid,p_until timestamptz,p_environment text,p_version uuid,p_purpose text) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE r orange_business.material_ingestions%ROWTYPE;permission jsonb;BEGIN
 PERFORM orange_business.identity(p_actor,p_session,p_until);permission:=orange_business.material(p_actor,p_version,p_purpose);
 SELECT * INTO r FROM orange_business.material_ingestions WHERE owner_id=p_actor AND environment_id=p_environment AND version_id=p_version AND state='registered' FOR SHARE;
 IF NOT FOUND OR permission->>'contentSha256'<>r.sha256 OR (permission->>'probeRevision')::bigint<>r.probe_revision THEN RAISE EXCEPTION 'orange:material-unavailable';END IF;
 PERFORM orange_business.identity(p_actor,p_session,p_until);RETURN orange_business.ingestion_reply(r);
END$$;
REVOKE ALL ON FUNCTION orange_business.ingestion_reply(orange_business.material_ingestions) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION orange_business.ingestion_reply(orange_business.material_ingestions) TO service_role;
DO $$DECLARE f regprocedure;BEGIN FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=ANY(ARRAY['orange_begin_material','orange_finish_material','orange_locate_material']) LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f);EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f);END LOOP;END$$;
COMMIT;
