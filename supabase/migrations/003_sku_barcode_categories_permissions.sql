-- BMH Inventario: SKU consecutivo, código de barras automático, categorías y permisos del creador.
-- Ejecutar después de 001 y 002. No elimina productos ni movimientos.
create sequence if not exists public.bmh_product_sku_seq start 1 increment 1;
create sequence if not exists public.bmh_product_barcode_seq start 1 increment 1;

create table if not exists public.product_categories (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  warehouse_id uuid not null references public.warehouses(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  unique (warehouse_id, name),
  foreign key (warehouse_id, business_id) references public.warehouses(id,business_id) on delete cascade
);
create index if not exists product_categories_warehouse_idx on public.product_categories(warehouse_id, name);
alter table public.product_categories enable row level security;
drop policy if exists categories_select_member on public.product_categories;
create policy categories_select_member on public.product_categories for select to authenticated
using (public.is_business_member(business_id));
drop policy if exists categories_insert_member on public.product_categories;
create policy categories_insert_member on public.product_categories for insert to authenticated
with check (public.is_business_member(business_id) and created_by=(select auth.uid()));
drop policy if exists categories_update_creator on public.product_categories;
create policy categories_update_creator on public.product_categories for update to authenticated
using (exists(select 1 from public.businesses b where b.id=business_id and b.created_by=(select auth.uid())))
with check (exists(select 1 from public.businesses b where b.id=business_id and b.created_by=(select auth.uid())));
drop policy if exists categories_delete_creator on public.product_categories;
create policy categories_delete_creator on public.product_categories for delete to authenticated
using (exists(select 1 from public.businesses b where b.id=business_id and b.created_by=(select auth.uid())));
grant select, insert, update, delete on public.product_categories to authenticated;

-- Permisos granulares por integrante. El creador del negocio es la autoridad final.
alter table public.business_members add column if not exists can_manage_products boolean not null default false;
alter table public.business_members add column if not exists can_record_movements boolean not null default true;
alter table public.business_members add column if not exists can_view_finance boolean not null default false;
update public.business_members bm set can_manage_products=true, can_record_movements=true, can_view_finance=true
from public.businesses b where b.id=bm.business_id and b.created_by=bm.user_id;

create or replace function public.can_manage_business(p_business uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.businesses b where b.id=p_business and b.created_by=(select auth.uid()));
$$;
create or replace function public.can_view_finances(p_business uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.businesses b join public.business_members m on m.business_id=b.id
    where b.id=p_business and m.user_id=(select auth.uid()) and (b.created_by=(select auth.uid()) or m.can_view_finance));
$$;
revoke all on function public.can_manage_business(uuid) from public, anon;
revoke all on function public.can_view_finances(uuid) from public, anon;
grant execute on function public.can_manage_business(uuid), public.can_view_finances(uuid) to authenticated;

create or replace function public.set_member_permissions(
  p_business_id uuid, p_user_id uuid, p_can_manage_products boolean,
  p_can_record_movements boolean, p_can_view_finance boolean
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists(select 1 from public.businesses b where b.id=p_business_id and b.created_by=(select auth.uid())) then
    raise exception 'Solo el creador del almacén puede modificar permisos.';
  end if;
  if p_user_id=(select auth.uid()) then raise exception 'No puedes cambiar tus propios permisos desde esta sección.'; end if;
  update public.business_members set can_manage_products=p_can_manage_products,
    can_record_movements=p_can_record_movements, can_view_finance=p_can_view_finance
  where business_id=p_business_id and user_id=p_user_id;
  if not found then raise exception 'El usuario no pertenece a este almacén.'; end if;
end; $$;
revoke all on function public.set_member_permissions(uuid,uuid,boolean,boolean,boolean) from public, anon;
grant execute on function public.set_member_permissions(uuid,uuid,boolean,boolean,boolean) to authenticated;

create or replace function public.assign_bmh_product_codes()
returns trigger language plpgsql security definer set search_path = '' as $$
declare n bigint; raw_code text; sum_digits integer := 0; digit integer; i integer; barcode12 text; checksum integer;
begin
  if nullif(trim(coalesce(new.code,'')),'') is null then
    n := nextval('public.bmh_product_sku_seq');
    new.code := 'BMH-' || lpad(n::text,5,'0');
  end if;
  if nullif(trim(coalesce(new.barcode,'')),'') is null then
    n := nextval('public.bmh_product_barcode_seq');
    barcode12 := '200' || lpad(n::text,9,'0');
    for i in 1..12 loop
      digit := substr(barcode12,i,1)::integer;
      sum_digits := sum_digits + digit * case when i % 2 = 0 then 3 else 1 end;
    end loop;
    checksum := (10 - (sum_digits % 10)) % 10;
    new.barcode := barcode12 || checksum::text;
  end if;
  return new;
end; $$;
drop trigger if exists products_assign_bmh_codes on public.products;
create trigger products_assign_bmh_codes before insert on public.products
for each row execute function public.assign_bmh_product_codes();
create unique index if not exists products_barcode_unique on public.products(barcode) where barcode is not null and barcode <> '';

-- Para usuarios nuevos, el creador recibe permisos completos; el resto conserva permisos limitados.
-- Exige autorización explícita para registrar movimientos.
create or replace function public.record_inventory_movement(
 p_product_id uuid, p_movement_type text, p_quantity numeric, p_reason text, p_notes text default null
) returns public.inventory_movements language plpgsql security definer set search_path = '' as $$
declare v_product public.products%rowtype; v_before numeric(14,3); v_after numeric(14,3); v_move public.inventory_movements%rowtype; v_name text;
begin
 if (select auth.uid()) is null then raise exception 'Debes iniciar sesión.'; end if;
 if p_quantity is null or p_quantity <= 0 then raise exception 'La cantidad debe ser mayor que cero.'; end if;
 if p_movement_type not in ('entry','exit','adjustment') then raise exception 'Tipo de movimiento no válido.'; end if;
 select * into v_product from public.products where id=p_product_id for update;
 if not found then raise exception 'Producto no encontrado.'; end if;
 if not exists(select 1 from public.business_members bm where bm.business_id=v_product.business_id and bm.user_id=(select auth.uid()) and (bm.warehouse_id is null or bm.warehouse_id=v_product.warehouse_id) and bm.can_record_movements) then raise exception 'No tienes permiso para registrar movimientos en este almacén.'; end if;
 if p_movement_type='adjustment' and not public.can_manage_business(v_product.business_id) then raise exception 'Solo el creador puede ajustar existencias.'; end if;
 select coalesce(nullif(trim(p.full_name),''),split_part(coalesce(u.email,'Usuario'),'@',1),'Usuario') into v_name
 from auth.users u left join public.profiles p on p.id=u.id where u.id=(select auth.uid());
 v_before := v_product.stock;
 if p_movement_type='entry' then v_after := v_before+p_quantity; else v_after := v_before-p_quantity; end if;
 if v_after < 0 then raise exception 'Existencia insuficiente. Disponible: % %',v_before,v_product.unit; end if;
 update public.products set stock=v_after,updated_at=now() where id=p_product_id;
 insert into public.inventory_movements(business_id,warehouse_id,product_id,movement_type,quantity,reason,notes,stock_before,stock_after,user_id,user_name,product_name,unit)
 values(v_product.business_id,v_product.warehouse_id,p_product_id,p_movement_type,p_quantity,coalesce(nullif(trim(p_reason),''),'Otro'),p_notes,v_before,v_after,(select auth.uid()),v_name,v_product.name,v_product.unit) returning * into v_move;
 return v_move;
end; $$;
revoke all on function public.record_inventory_movement(uuid,text,numeric,text,text) from public, anon;
grant execute on function public.record_inventory_movement(uuid,text,numeric,text,text) to authenticated;

-- Los permisos delegados se aplican también en las políticas de productos.
drop policy if exists products_manager_insert on public.products;
create policy products_manager_insert on public.products for insert to authenticated
with check (
  created_by=(select auth.uid()) and exists(select 1 from public.business_members bm
    where bm.business_id=products.business_id and bm.user_id=(select auth.uid())
      and (public.can_manage_business(products.business_id) or bm.can_manage_products))
);
drop policy if exists products_manager_update on public.products;
create policy products_manager_update on public.products for update to authenticated
using (exists(select 1 from public.business_members bm where bm.business_id=products.business_id and bm.user_id=(select auth.uid()) and (public.can_manage_business(products.business_id) or bm.can_manage_products)))
with check (exists(select 1 from public.business_members bm where bm.business_id=products.business_id and bm.user_id=(select auth.uid()) and (public.can_manage_business(products.business_id) or bm.can_manage_products)));
drop policy if exists products_manager_delete on public.products;
create policy products_manager_delete on public.products for delete to authenticated
using (exists(select 1 from public.business_members bm where bm.business_id=products.business_id and bm.user_id=(select auth.uid()) and (public.can_manage_business(products.business_id) or bm.can_manage_products)));
