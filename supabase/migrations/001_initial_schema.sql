-- BMH Inventario: esquema inicial multi-negocio. Ejecutar una sola vez en Supabase SQL Editor.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 2 and 120),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);
create table if not exists public.business_members (
  business_id uuid not null references public.businesses(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'operator' check (role in ('owner','admin','operator')),
  can_view_finance boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (business_id,user_id)
);
create table if not exists public.warehouses (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null,
  code text not null unique default ('BMH-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,8))),
  created_at timestamptz not null default now(),
  unique (business_id,name),
  unique (id,business_id)
);
create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  warehouse_id uuid not null references public.warehouses(id) on delete restrict,
  name text not null check(length(trim(name)) between 1 and 180),
  code text,
  category text not null default 'General',
  location text,
  barcode text,
  supplier text,
  sale_price numeric(14,2) check(sale_price is null or sale_price >= 0),
  cost_price numeric(14,2) check(cost_price is null or cost_price >= 0),
  stock numeric(14,3) not null default 0 check(stock >= 0),
  unit text not null default 'Pieza',
  min_stock numeric(14,3) not null default 0 check(min_stock >= 0),
  description text,
  active boolean not null default true,
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(warehouse_id,code),
  constraint product_warehouse_business_match foreign key (warehouse_id,business_id) references public.warehouses(id,business_id) deferrable initially immediate
);
create table if not exists public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  warehouse_id uuid not null references public.warehouses(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  movement_type text not null check(movement_type in ('initial','entry','exit','adjustment')),
  quantity numeric(14,3) not null check(quantity > 0),
  reason text not null,
  notes text,
  stock_before numeric(14,3) not null,
  stock_after numeric(14,3) not null check(stock_after >= 0),
  user_id uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  reversed_movement_id uuid references public.inventory_movements(id)
);
create index if not exists products_business_warehouse_idx on public.products(business_id,warehouse_id,active);
create index if not exists products_name_idx on public.products using gin (to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(code,'') || ' ' || coalesce(barcode,'')));
create index if not exists movements_business_created_idx on public.inventory_movements(business_id,created_at desc);
create index if not exists movements_product_idx on public.inventory_movements(product_id,created_at desc);

create or replace function public.is_business_member(p_business uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.business_members m where m.business_id=p_business and m.user_id=(select auth.uid()));
$$;
create or replace function public.can_manage_business(p_business uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.business_members m where m.business_id=p_business and m.user_id=(select auth.uid()) and m.role in ('owner','admin'));
$$;
create or replace function public.can_view_finances(p_business uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.business_members m where m.business_id=p_business and m.user_id=(select auth.uid()) and (m.role='owner' or m.can_view_finance));
$$;

revoke all on function public.is_business_member(uuid) from public, anon;
revoke all on function public.can_manage_business(uuid) from public, anon;
revoke all on function public.can_view_finances(uuid) from public, anon;
grant execute on function public.is_business_member(uuid), public.can_manage_business(uuid), public.can_view_finances(uuid) to authenticated;

create or replace function public.create_business_with_warehouse(p_business_name text, p_warehouse_name text default 'Almacén principal')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_business uuid; v_warehouse uuid; v_code text;
begin
  if (select auth.uid()) is null then raise exception 'Debes iniciar sesión.'; end if;
  if length(trim(coalesce(p_business_name,''))) < 2 then raise exception 'Escribe el nombre del negocio.'; end if;
  insert into public.businesses(name,created_by) values(trim(p_business_name),(select auth.uid())) returning id into v_business;
  insert into public.business_members(business_id,user_id,role,can_view_finance) values(v_business,(select auth.uid()),'owner',true);
  insert into public.warehouses(business_id,name) values(v_business,coalesce(nullif(trim(p_warehouse_name),''),'Almacén principal')) returning id,code into v_warehouse,v_code;
  return jsonb_build_object('business_id',v_business,'warehouse_id',v_warehouse,'warehouse_code',v_code);
end; $$;
revoke all on function public.create_business_with_warehouse(text,text) from public, anon;
grant execute on function public.create_business_with_warehouse(text,text) to authenticated;

create or replace function public.record_inventory_movement(
 p_product_id uuid, p_movement_type text, p_quantity numeric, p_reason text, p_notes text default null
) returns public.inventory_movements language plpgsql security definer set search_path = '' as $$
declare v_product public.products%rowtype; v_before numeric(14,3); v_after numeric(14,3); v_move public.inventory_movements%rowtype;
begin
 if (select auth.uid()) is null then raise exception 'Debes iniciar sesión.'; end if;
 if p_quantity is null or p_quantity <= 0 then raise exception 'La cantidad debe ser mayor que cero.'; end if;
 if p_movement_type not in ('entry','exit','adjustment') then raise exception 'Tipo de movimiento no válido.'; end if;
 select * into v_product from public.products where id=p_product_id for update;
 if not found then raise exception 'Producto no encontrado o sin permiso.'; end if;
 if not public.is_business_member(v_product.business_id) then raise exception 'No tienes acceso a este negocio.'; end if;
 if p_movement_type='adjustment' and not public.can_manage_business(v_product.business_id) then raise exception 'Solo un jefe o administrador puede ajustar existencias.'; end if;
 v_before := v_product.stock;
 if p_movement_type='entry' then v_after := v_before+p_quantity; else v_after := v_before-p_quantity; end if;
 if v_after < 0 then raise exception 'Existencia insuficiente. Disponible: % %',v_before,v_product.unit; end if;
 update public.products set stock=v_after,updated_at=now() where id=p_product_id;
 insert into public.inventory_movements(business_id,warehouse_id,product_id,movement_type,quantity,reason,notes,stock_before,stock_after,user_id)
 values(v_product.business_id,v_product.warehouse_id,p_product_id,p_movement_type,p_quantity,coalesce(nullif(trim(p_reason),''),'Otro'),p_notes,v_before,v_after,(select auth.uid())) returning * into v_move;
 return v_move;
end; $$;
revoke all on function public.record_inventory_movement(uuid,text,numeric,text,text) from public, anon;
grant execute on function public.record_inventory_movement(uuid,text,numeric,text,text) to authenticated;

-- Perfil automático para nuevas cuentas Auth.
create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = '' as $$
begin
 insert into public.profiles(id,full_name) values(new.id,coalesce(new.raw_user_meta_data->>'full_name','')) on conflict(id) do nothing;
 return new;
end; $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute procedure public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.businesses enable row level security;
alter table public.business_members enable row level security;
alter table public.warehouses enable row level security;
alter table public.products enable row level security;
alter table public.inventory_movements enable row level security;

drop policy if exists profile_select_self on public.profiles;
create policy profile_select_self on public.profiles for select to authenticated using(id=(select auth.uid()));
drop policy if exists profile_update_self on public.profiles;
create policy profile_update_self on public.profiles for update to authenticated using(id=(select auth.uid())) with check(id=(select auth.uid()));
drop policy if exists business_select_member on public.businesses;
create policy business_select_member on public.businesses for select to authenticated using(public.is_business_member(id));
drop policy if exists member_select_same_business on public.business_members;
create policy member_select_same_business on public.business_members for select to authenticated using(public.is_business_member(business_id));
drop policy if exists member_manage_admin on public.business_members;
create policy member_manage_admin on public.business_members for all to authenticated using(public.can_manage_business(business_id)) with check(public.can_manage_business(business_id));
drop policy if exists warehouses_member_all on public.warehouses;
create policy warehouses_member_all on public.warehouses for all to authenticated using(public.is_business_member(business_id)) with check(public.is_business_member(business_id));
drop policy if exists products_member_select on public.products;
create policy products_member_select on public.products for select to authenticated using(public.is_business_member(business_id));
drop policy if exists products_manager_insert on public.products;
create policy products_manager_insert on public.products for insert to authenticated with check(public.can_manage_business(business_id) and created_by=(select auth.uid()));
drop policy if exists products_manager_update on public.products;
create policy products_manager_update on public.products for update to authenticated using(public.can_manage_business(business_id)) with check(public.can_manage_business(business_id));
drop policy if exists products_manager_delete on public.products;
create policy products_manager_delete on public.products for delete to authenticated using(public.can_manage_business(business_id));
drop policy if exists movements_member_select on public.inventory_movements;
create policy movements_member_select on public.inventory_movements for select to authenticated using(public.is_business_member(business_id));
-- Los movimientos solo se crean mediante la función transaccional, no mediante INSERT directo.
revoke insert, update, delete on public.inventory_movements from anon, authenticated;
grant select on public.profiles,public.businesses,public.business_members,public.warehouses,public.products,public.inventory_movements to authenticated;
grant update(full_name) on public.profiles to authenticated;
grant insert,update,delete on public.products to authenticated;
grant insert,update,delete on public.warehouses to authenticated;
