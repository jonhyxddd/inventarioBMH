-- BMH Inventario: unión por código y nombre del usuario en auditoría.
-- Ejecutar DESPUÉS de 001_initial_schema.sql en Supabase SQL Editor.
alter table public.business_members add column if not exists warehouse_id uuid references public.warehouses(id) on delete set null;
update public.business_members bm set warehouse_id=(select w.id from public.warehouses w where w.business_id=bm.business_id order by w.created_at limit 1) where bm.warehouse_id is null;
alter table public.inventory_movements add column if not exists user_name text;
alter table public.inventory_movements add column if not exists product_name text;
alter table public.inventory_movements add column if not exists unit text;
update public.inventory_movements m set user_name=coalesce(nullif((select p.full_name from public.profiles p where p.id=m.user_id),''),(select split_part(u.email,'@',1) from auth.users u where u.id=m.user_id),'Usuario'), product_name=(select pr.name from public.products pr where pr.id=m.product_id), unit=(select pr.unit from public.products pr where pr.id=m.product_id) where m.user_name is null or m.product_name is null or m.unit is null;

-- Permite que integrantes del mismo negocio consulten solo el nombre de sus compañeros
-- mediante la política RLS de perfiles (la tabla contiene únicamente datos de perfil básicos).
drop policy if exists profiles_select_coworkers on public.profiles;
create policy profiles_select_coworkers on public.profiles for select to authenticated
using (exists (
 select 1 from public.business_members mine
 join public.business_members theirs on theirs.business_id=mine.business_id
 where mine.user_id=(select auth.uid()) and theirs.user_id=profiles.id
));

create or replace function public.join_warehouse_by_code(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_wh public.warehouses%rowtype; v_uid uuid; v_role text;
begin
 v_uid := (select auth.uid());
 if v_uid is null then raise exception 'Debes iniciar sesión.'; end if;
 if nullif(trim(p_code),'') is null then raise exception 'Escribe el código del almacén.'; end if;
 select * into v_wh from public.warehouses where upper(code)=upper(trim(p_code)) limit 1;
 if not found then raise exception 'No encontramos un almacén con ese código. Verifica las letras y números.'; end if;
 -- La primera persona que creó el negocio sigue siendo propietaria; quienes se unen son operadores.
 insert into public.business_members(business_id,user_id,role,can_view_finance,warehouse_id)
 values(v_wh.business_id,v_uid,'operator',false,v_wh.id)
 on conflict(business_id,user_id) do update set warehouse_id=excluded.warehouse_id;
 return jsonb_build_object('business_id',v_wh.business_id,'warehouse_id',v_wh.id,'warehouse_name',v_wh.name,'warehouse_code',v_wh.code);
end; $$;
revoke all on function public.join_warehouse_by_code(text) from public, anon;
grant execute on function public.join_warehouse_by_code(text) to authenticated;

create or replace function public.record_inventory_movement(
 p_product_id uuid, p_movement_type text, p_quantity numeric, p_reason text, p_notes text default null
) returns public.inventory_movements language plpgsql security definer set search_path = '' as $$
declare v_product public.products%rowtype; v_before numeric(14,3); v_after numeric(14,3); v_move public.inventory_movements%rowtype; v_name text;
begin
 if (select auth.uid()) is null then raise exception 'Debes iniciar sesión.'; end if;
 if p_quantity is null or p_quantity <= 0 then raise exception 'La cantidad debe ser mayor que cero.'; end if;
 if p_movement_type not in ('entry','exit','adjustment') then raise exception 'Tipo de movimiento no válido.'; end if;
 select * into v_product from public.products where id=p_product_id for update;
 if not found then raise exception 'Producto no encontrado o sin permiso.'; end if;
 if not exists(select 1 from public.business_members bm where bm.business_id=v_product.business_id and bm.user_id=(select auth.uid()) and (bm.warehouse_id is null or bm.warehouse_id=v_product.warehouse_id)) then raise exception 'No tienes acceso a este almacén.'; end if;
 if p_movement_type='adjustment' and not public.can_manage_business(v_product.business_id) then raise exception 'Solo un jefe o administrador puede ajustar existencias.'; end if;
 v_before := v_product.stock;
 if p_movement_type='entry' then v_after := v_before+p_quantity; else v_after := v_before-p_quantity; end if;
 if v_after < 0 then raise exception 'Existencia insuficiente. Disponible: % %',v_before,v_product.unit; end if;
 select coalesce(nullif(trim(p.full_name),''),nullif(split_part(u.email,'@',1),''),'Usuario') into v_name
 from auth.users u left join public.profiles p on p.id=u.id where u.id=(select auth.uid());
 update public.products set stock=v_after,updated_at=now() where id=p_product_id;
 insert into public.inventory_movements(business_id,warehouse_id,product_id,movement_type,quantity,reason,notes,stock_before,stock_after,user_id,user_name,product_name,unit)
 values(v_product.business_id,v_product.warehouse_id,p_product_id,p_movement_type,p_quantity,coalesce(nullif(trim(p_reason),''),'Otro'),p_notes,v_before,v_after,(select auth.uid()),v_name,v_product.name,v_product.unit) returning * into v_move;
 return v_move;
end; $$;
revoke all on function public.record_inventory_movement(uuid,text,numeric,text,text) from public, anon;
grant execute on function public.record_inventory_movement(uuid,text,numeric,text,text) to authenticated;

-- Asegura que los nuevos propietarios queden asignados al almacén que acaban de crear.
create or replace function public.create_business_with_warehouse(p_business_name text, p_warehouse_name text default 'Almacén principal')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_business uuid; v_warehouse uuid; v_code text; v_uid uuid;
begin
 v_uid := (select auth.uid());
 if v_uid is null then raise exception 'Debes iniciar sesión.'; end if;
 if length(trim(coalesce(p_business_name,''))) < 2 then raise exception 'Escribe el nombre del negocio.'; end if;
 insert into public.businesses(name,created_by) values(trim(p_business_name),v_uid) returning id into v_business;
 insert into public.business_members(business_id,user_id,role,can_view_finance) values(v_business,v_uid,'owner',true);
 insert into public.warehouses(business_id,name) values(v_business,coalesce(nullif(trim(p_warehouse_name),''),'Almacén principal')) returning id,code into v_warehouse,v_code;
 update public.business_members set warehouse_id=v_warehouse where business_id=v_business and user_id=v_uid;
 return jsonb_build_object('business_id',v_business,'warehouse_id',v_warehouse,'warehouse_code',v_code);
end; $$;
revoke all on function public.create_business_with_warehouse(text,text) from public, anon;
grant execute on function public.create_business_with_warehouse(text,text) to authenticated;

-- Restringe lecturas de inventario al almacén asignado al integrante.
drop policy if exists warehouses_member_all on public.warehouses;
create policy warehouses_member_all on public.warehouses for select to authenticated
using (exists(select 1 from public.business_members bm where bm.business_id=warehouses.business_id and bm.user_id=(select auth.uid()) and (bm.warehouse_id is null or bm.warehouse_id=warehouses.id)));
drop policy if exists warehouses_manager_insert on public.warehouses;
drop policy if exists warehouses_manager_update on public.warehouses;
drop policy if exists warehouses_manager_delete on public.warehouses;
create policy warehouses_manager_insert on public.warehouses for insert to authenticated with check(public.can_manage_business(business_id));
create policy warehouses_manager_update on public.warehouses for update to authenticated using(public.can_manage_business(business_id)) with check(public.can_manage_business(business_id));
create policy warehouses_manager_delete on public.warehouses for delete to authenticated using(public.can_manage_business(business_id));
drop policy if exists products_member_select on public.products;
create policy products_member_select on public.products for select to authenticated
using (exists(select 1 from public.business_members bm where bm.business_id=products.business_id and bm.user_id=(select auth.uid()) and (bm.warehouse_id is null or bm.warehouse_id=products.warehouse_id)));
drop policy if exists movements_member_select on public.inventory_movements;
create policy movements_member_select on public.inventory_movements for select to authenticated
using (exists(select 1 from public.business_members bm where bm.business_id=inventory_movements.business_id and bm.user_id=(select auth.uid()) and (bm.warehouse_id is null or bm.warehouse_id=inventory_movements.warehouse_id)));
