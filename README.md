# BMH Inventario — base funcional inicial

Aplicación React + TypeScript + Vite conectada a Supabase. Incluye autenticación, creación inicial de negocio/almacén, catálogo de productos, precios/costos, movimientos de inventario transaccionales, historial, resumen financiero y exportación CSV.

## 1. Configurar Supabase

1. Abre el proyecto Supabase que corresponde a la URL configurada.
2. Ve a **SQL Editor → New query**.
3. Copia y ejecuta el contenido completo de `supabase/migrations/001_initial_schema.sql`.
4. Ve a **Authentication → URL Configuration** y configura `Site URL` para desarrollo como `http://localhost:5173`. Puedes añadir esa dirección a Redirect URLs si hace falta.
5. En Authentication → Providers → Email, decide si quieres confirmación por correo. Si está activa, confirma el correo antes de iniciar sesión.
6. En Project Settings / API Keys, usa la **publishable key** (`sb_publishable_...`) y la URL del proyecto. Nunca uses `sb_secret_...` o `service_role` en el frontend.

## 2. Configurar localmente

1. Instala Node.js LTS desde https://nodejs.org si `npm` no se reconoce en PowerShell; después cierra y vuelve a abrir la terminal.
2. En la carpeta del proyecto, copia `.env.example` a `.env.local`.
3. Completa `.env.local`:

```env
VITE_SUPABASE_URL=https://TU-PROYECTO.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_TU_CLAVE
```

4. En una terminal dentro de la carpeta:

```bash
npm install
npm run dev
```

5. Abre la URL local que indique Vite (normalmente `http://localhost:5173`). Crea cuenta, inicia sesión y crea negocio/almacén.

## Seguridad y límites de esta primera entrega

- La publishable key está diseñada para usarse en el cliente, pero la seguridad depende de RLS y permisos. Nunca publiques una secret/service-role key.
- Los movimientos de stock se registran mediante una función SQL transaccional; la salida no permite dejar stock negativo.
- La aplicación inicial tiene roles owner/admin/operator en la base de datos, pero la interfaz aún no implementa administración completa de usuarios ni una pantalla de permisos por rol. El panel financiero se muestra en la interfaz al usuario de sesión actual: antes de usar con empleados, hay que agregar control visual por rol y pruebas de autorización de todas las operaciones.
- El catálogo todavía no tiene edición/archivado visual, importación masiva ni búsqueda avanzada por filtros.
- No incluye POS completo, pagos, cortes de caja, facturación fiscal CFDI, planes SaaS/pagos ni calendario mensual. Son siguientes fases, no deben considerarse ya implementadas.
- Define y documenta si los precios del negocio incluyen IVA o se capturan antes de IVA. Esta versión muestra importes nominales y no calcula impuestos oficiales.
- Antes de producción: probar las políticas RLS con cuentas separadas, añadir pruebas automatizadas, copias de seguridad y despliegue HTTPS.


## Actualización 2: unión por código, usuario y PDF
1. En Supabase → SQL Editor, ejecuta `supabase/migrations/002_warehouse_join_usernames.sql` después de la migración 001.
2. Ejecuta `npm install` para instalar `jspdf` y `jspdf-autotable`.
3. Prueba crear una cuenta nueva, crear almacén, copiar el código, abrir otra cuenta y unirse usando ese código.
4. Registra una salida y comprueba que el historial muestre el usuario. En Reportes PDF selecciona Hoy, Esta semana, Este mes o Personalizado.

## Publicación en Vercel
1. Sube el contenido del proyecto a un repositorio privado de GitHub (no subas `.env.local`).
2. En Vercel, importa el repositorio. Framework: Vite; Build Command: `npm run build`; Output Directory: `dist`.
3. En Project Settings → Environment Variables añade `VITE_SUPABASE_URL` y `VITE_SUPABASE_PUBLISHABLE_KEY` con los valores del proyecto Supabase. No uses `service_role` ni `sb_secret`.
4. Deploy. En Supabase → Authentication → URL Configuration, cambia Site URL a tu dominio publicado y añade también `http://localhost:5173` en Redirect URLs para pruebas.
5. Antes de usarlo con empleados o datos reales, revisar permisos/RLS de precios y resumen financiero; este MVP requiere una revisión de roles antes de producción.

## Actualización 3: SKU, barras, categorías y opciones
Ejecuta `supabase/migrations/003_sku_barcode_categories_permissions.sql` después de las migraciones 001 y 002. Consulta `INSTRUCCIONES_ACTUALIZACION_3.txt` antes de aplicarla. El SKU y código de barras se generan en PostgreSQL si se dejan vacíos al crear el producto. Las categorías se guardan por almacén. La interfaz incluye modo oscuro y alta de categorías.
