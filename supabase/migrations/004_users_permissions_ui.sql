-- BMH Inventario: soporte para la pantalla Opciones > Usuarios y permisos.
-- Ejecutar después de las migraciones 001, 002 y 003. No borra datos existentes.

ALTER TABLE public.business_members
  ADD COLUMN IF NOT EXISTS can_manage_products boolean NOT NULL DEFAULT false;
ALTER TABLE public.business_members
  ADD COLUMN IF NOT EXISTS can_record_movements boolean NOT NULL DEFAULT true;
ALTER TABLE public.business_members
  ADD COLUMN IF NOT EXISTS can_view_finance boolean NOT NULL DEFAULT false;

-- Garantiza que exista la tabla de categorías esperada por la interfaz actual.
CREATE TABLE IF NOT EXISTS public.product_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL REFERENCES public.warehouses(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  created_by uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (warehouse_id, name),
  FOREIGN KEY (warehouse_id, business_id) REFERENCES public.warehouses(id, business_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS product_categories_warehouse_idx ON public.product_categories(warehouse_id, name);
ALTER TABLE public.product_categories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS categories_select_member ON public.product_categories;
CREATE POLICY categories_select_member ON public.product_categories FOR SELECT TO authenticated
USING (public.is_business_member(business_id));
DROP POLICY IF EXISTS categories_insert_member ON public.product_categories;
CREATE POLICY categories_insert_member ON public.product_categories FOR INSERT TO authenticated
WITH CHECK (public.is_business_member(business_id) AND created_by = (SELECT auth.uid()));
DROP POLICY IF EXISTS categories_update_creator ON public.product_categories;
CREATE POLICY categories_update_creator ON public.product_categories FOR UPDATE TO authenticated
USING (EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = business_id AND b.created_by = (SELECT auth.uid())))
WITH CHECK (EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = business_id AND b.created_by = (SELECT auth.uid())));
DROP POLICY IF EXISTS categories_delete_creator ON public.product_categories;
CREATE POLICY categories_delete_creator ON public.product_categories FOR DELETE TO authenticated
USING (EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = business_id AND b.created_by = (SELECT auth.uid())));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_categories TO authenticated;

-- El creador conserva todos los permisos independientemente de los valores guardados.
UPDATE public.business_members bm
SET can_manage_products = true,
    can_record_movements = true,
    can_view_finance = true
FROM public.businesses b
WHERE b.id = bm.business_id AND b.created_by = bm.user_id;

CREATE TABLE IF NOT EXISTS public.business_member_permission_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL REFERENCES auth.users(id),
  target_user_id uuid NOT NULL REFERENCES auth.users(id),
  old_permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
  new_permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.business_member_permission_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS business_permission_audit_owner_read ON public.business_member_permission_audit;
CREATE POLICY business_permission_audit_owner_read
ON public.business_member_permission_audit FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.businesses b
  WHERE b.id = business_id AND b.created_by = (SELECT auth.uid())
));
GRANT SELECT ON public.business_member_permission_audit TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.business_member_permission_audit FROM authenticated;

CREATE OR REPLACE FUNCTION public.set_member_permissions(
  p_business_id uuid,
  p_user_id uuid,
  p_can_manage_products boolean,
  p_can_record_movements boolean,
  p_can_view_finance boolean
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_old jsonb;
  v_new jsonb;
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN
    RAISE EXCEPTION 'Debes iniciar sesión.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.businesses b
    WHERE b.id = p_business_id AND b.created_by = (SELECT auth.uid())
  ) THEN
    RAISE EXCEPTION 'Solo el creador del negocio puede administrar permisos.';
  END IF;
  IF p_user_id = (SELECT auth.uid()) THEN
    RAISE EXCEPTION 'No puedes modificar tus propios permisos desde esta sección.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.businesses b
    WHERE b.id = p_business_id AND b.created_by = p_user_id
  ) THEN
    RAISE EXCEPTION 'No se pueden modificar los permisos del propietario.';
  END IF;
  SELECT jsonb_build_object(
    'can_manage_products', bm.can_manage_products,
    'can_record_movements', bm.can_record_movements,
    'can_view_finance', bm.can_view_finance
  ) INTO v_old
  FROM public.business_members bm
  WHERE bm.business_id = p_business_id AND bm.user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'El usuario no pertenece a este negocio.';
  END IF;
  UPDATE public.business_members
  SET can_manage_products = COALESCE(p_can_manage_products, false),
      can_record_movements = COALESCE(p_can_record_movements, false),
      can_view_finance = COALESCE(p_can_view_finance, false)
  WHERE business_id = p_business_id AND user_id = p_user_id;
  v_new := jsonb_build_object(
    'can_manage_products', COALESCE(p_can_manage_products, false),
    'can_record_movements', COALESCE(p_can_record_movements, false),
    'can_view_finance', COALESCE(p_can_view_finance, false)
  );
  INSERT INTO public.business_member_permission_audit
    (business_id, actor_user_id, target_user_id, old_permissions, new_permissions)
  VALUES
    (p_business_id, (SELECT auth.uid()), p_user_id, COALESCE(v_old, '{}'::jsonb), v_new);
END;
$$;
REVOKE ALL ON FUNCTION public.set_member_permissions(uuid,uuid,boolean,boolean,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_member_permissions(uuid,uuid,boolean,boolean,boolean) TO authenticated;

NOTIFY pgrst, 'reload schema';
