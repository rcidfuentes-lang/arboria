-- Lo minimo de Supabase que las migraciones dan por hecho, para poder
-- aplicarlas en un Postgres de usar y tirar.
--
-- Los roles, el esquema auth y auth.uid(). Y, sobre todo, el ALTER DEFAULT
-- PRIVILEGES que Supabase tiene puesto sobre el esquema public: sin el, la
-- prueba de que cada funcion solo la puede llamar el rol que toca no prueba
-- nada, porque el problema que hubo era justamente ese.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create schema auth;
create table auth.users (id uuid primary key);
grant usage on schema auth to anon, authenticated;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema public to anon, authenticated;
-- Supabase concede por defecto todo sobre las tablas de public a anon y
-- authenticated. Se reproduce para que el revoke de la migracion se pruebe
-- de verdad.
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on functions to anon, authenticated;
