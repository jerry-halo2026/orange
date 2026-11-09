-- LOCAL SYNTHETIC TEST ONLY. Never deploy to managed Supabase or use real user rows.
DO $$ BEGIN
 IF current_database() <> 'orange_test' OR current_setting('orange.synthetic_test',true) IS DISTINCT FROM 'true' THEN
  RAISE EXCEPTION 'local synthetic bootstrap guard';
 END IF;
END $$;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE TABLE auth.users(id uuid PRIMARY KEY,is_anonymous boolean NOT NULL,deleted_at timestamptz,banned_until timestamptz);
CREATE TABLE auth.sessions(id uuid PRIMARY KEY,user_id uuid NOT NULL,not_after timestamptz);
REVOKE ALL ON SCHEMA auth FROM PUBLIC,anon,authenticated;
GRANT USAGE ON SCHEMA auth TO service_role;
GRANT SELECT(id,is_anonymous,deleted_at,banned_until) ON auth.users TO service_role;
GRANT SELECT(id,user_id,not_after) ON auth.sessions TO service_role;
INSERT INTO auth.users(id,is_anonymous) VALUES
 ('11111111-1111-4111-8111-111111111111',false),('22222222-2222-4222-8222-222222222222',false),('33333333-3333-4333-8333-333333333333',true);
INSERT INTO auth.sessions VALUES
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111',now()+interval '2 hours'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','22222222-2222-4222-8222-222222222222',now()+interval '2 hours');