
import { useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { supabase, configured } from './supabase';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import {
  Boxes, LayoutDashboard, Package, ArrowDownToLine, ArrowUpFromLine,
  History, Wallet, LogOut, Plus, Search, RefreshCw, Warehouse,
  ShieldCheck, AlertTriangle, FileText, Settings, Moon, Sun, Tags,
  Users, Save, UserCog
} from 'lucide-react';

type Product = {
  id: string;
  name: string;
  code: string | null;
  category: string;
  location: string | null;
  barcode: string | null;
  supplier: string | null;
  sale_price: number | null;
  cost_price: number | null;
  stock: number;
  unit: string;
  min_stock: number;
  description: string | null;
  warehouse_id: string;
  business_id: string;
  active: boolean;
};

type Business = { id: string; name: string; created_by?: string };
type Member = {
  user_id: string;
  role: string;
  can_manage_products: boolean;
  can_record_movements: boolean;
  can_view_finance: boolean;
  full_name: string;
};
type WarehouseType = { id: string; name: string; code: string };
type Move = {
  id: string;
  created_at: string;
  movement_type: string;
  quantity: number;
  reason: string;
  stock_before: number;
  stock_after: number;
  product_id: string;
  product_name?: string;
  unit?: string;
  user_name?: string;
  notes: string | null;
};

const units = [
  'Pieza', 'Caja', 'Paquete', 'Par', 'Metro', 'Centímetro',
  'Milímetro', 'Kilogramo', 'Gramo', 'Litro', 'Mililitro',
  'Ciento', 'Millar', 'Docena', 'Rollo', 'Cubeta', 'Saco',
  'Bulto', 'Tonelada'
];

const money = (n: number | null | undefined) =>
  n === null || n === undefined
    ? 'Sin registrar'
    : new Intl.NumberFormat('es-MX', {
        style: 'currency',
        currency: 'MXN'
      }).format(n);

export default function App() {
  const [session, setSession] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [business, setBusiness] = useState<Business | null>(null);
  const [warehouse, setWarehouse] = useState<WarehouseType | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [moves, setMoves] = useState<Move[]>([]);
  const [tab, setTab] = useState('dashboard');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [bizName, setBizName] = useState('BMH Suministros');
  const [whName, setWhName] = useState('Almacén principal');
  const [workspaceMode, setWorkspaceMode] = useState<'create' | 'join'>('create');
  const [joinCode, setJoinCode] = useState('');
  const [createdCode, setCreatedCode] = useState('');
  const [reportPeriod, setReportPeriod] = useState<'day' | 'week' | 'month' | 'custom'>('day');
  const [reportStart, setReportStart] = useState(new Date().toISOString().slice(0, 10));
  const [reportEnd, setReportEnd] = useState(new Date().toISOString().slice(0, 10));
  const [productModal, setProductModal] = useState(false);
  const [moveModal, setMoveModal] = useState<'entry' | 'exit' | null>(null);
  const [notice, setNotice] = useState('');

  const [form, setForm] = useState<any>({
    name: '',
    code: '',
    category: 'General',
    location: '',
    barcode: '',
    supplier: '',
    sale_price: '',
    cost_price: '',
    stock: '0',
    unit: 'Pieza',
    min_stock: '0',
    description: ''
  });

  const [moveForm, setMoveForm] = useState({
    product_id: '',
    quantity: '1',
    reason: 'Compra a proveedor',
    notes: ''
  });

  const [categories, setCategories] = useState<string[]>(['General']);
  const [newCategory, setNewCategory] = useState('');
  const [members, setMembers] = useState<Member[]>([]);
  const [savingMember, setSavingMember] = useState<string | null>(null);

  const [darkMode, setDarkMode] = useState(() => {
    try {
      return localStorage.getItem('bmh-theme') === 'dark';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    document.documentElement.dataset.theme = darkMode ? 'dark' : 'light';
    try {
      localStorage.setItem('bmh-theme', darkMode ? 'dark' : 'light');
    } catch {
      // El tema seguirá funcionando aunque el almacenamiento esté bloqueado.
    }
  }, [darkMode]);

  useEffect(() => {
    if (!supabase) {
      setLoading(false);
      return;
    }

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });

    const {
      data: { subscription }
    } = supabase.auth.onAuthStateChange((_event, currentSession) => {
      setSession(currentSession);
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (session?.user) {
      void loadWorkspace();
    } else {
      setBusiness(null);
      setWarehouse(null);
      setProducts([]);
      setMoves([]);
      setMembers([]);
    }
  }, [session?.user?.id]);

  async function loadWorkspace() {
    if (!supabase || !session?.user) return;

    setBusy(true);
    setErr('');

    try {
      const { data: member, error: memberError } = await supabase
        .from('business_members')
        .select('business_id, warehouse_id, businesses(id,name,created_by)')
        .eq('user_id', session.user.id)
        .limit(1)
        .maybeSingle();

      if (memberError) throw memberError;

      if (!member) {
        setBusiness(null);
        setWarehouse(null);
        return;
      }

      const selectedBusiness = (member as any).businesses as Business;
      setBusiness(selectedBusiness);

      await loadMembers(selectedBusiness.id);

      const { data: warehouses, error: warehouseError } = await supabase
        .from('warehouses')
        .select('id,name,code')
        .eq('business_id', selectedBusiness.id)
        .order('created_at')
        .limit(1);

      if (warehouseError) throw warehouseError;

      const selectedWarehouse =
        (warehouses || []).find(
          (w: any) => w.id === (member as any).warehouse_id
        ) || warehouses?.[0];

      if (selectedWarehouse) {
        setWarehouse(selectedWarehouse as WarehouseType);

        const { data: categoryRows, error: categoryError } = await supabase
          .from('product_categories')
          .select('name')
          .eq('warehouse_id', selectedWarehouse.id)
          .order('name');

        if (categoryError && !categoryError.message.includes('does not exist')) {
          throw categoryError;
        }

        setCategories([
          'General',
          ...Array.from(
            new Set(
              (categoryRows || [])
                .map((c: any) => c.name)
                .filter((name: string) => name !== 'General')
            )
          )
        ]);

        await loadData(selectedBusiness.id, selectedWarehouse.id);
      } else {
        setWarehouse(null);
      }
    } catch (e: any) {
      setErr(e.message || 'No se pudo cargar el negocio.');
    } finally {
      setBusy(false);
    }
  }

  async function loadMembers(bid = business?.id) {
    if (!supabase || !bid) return;

    try {
      const { data, error } = await supabase
        .from('business_members')
        .select(
          'user_id,role,can_manage_products,can_record_movements,can_view_finance,profiles(full_name)'
        )
        .eq('business_id', bid)
        .order('created_at', { ascending: true });

      if (error) throw error;

      setMembers(
        (data || []).map((m: any) => ({
          ...m,
          full_name: m.profiles?.full_name?.trim() || 'Usuario sin nombre'
        })) as Member[]
      );
    } catch (e: any) {
      setErr(e.message || 'No se pudieron cargar los usuarios.');
    }
  }

  async function saveMemberPermissions(member: Member) {
    if (!supabase || !business) return;

    setSavingMember(member.user_id);
    setErr('');

    try {
      // Los nombres deben coincidir con los parámetros de la función SQL.
      const { error } = await supabase.rpc('set_member_permissions', {
        p_business: business.id,
        p_user: member.user_id,
        p_can_view_finance: member.can_view_finance,
        p_can_manage_products: member.can_manage_products,
        p_can_record_movements: member.can_record_movements
      });

      if (error) throw error;

      setNotice('Permisos actualizados correctamente.');
      await loadMembers(business.id);
    } catch (e: any) {
      setErr(e.message || 'No se pudieron actualizar los permisos.');
    } finally {
      setSavingMember(null);
    }
  }

  function updateMemberPermission(
    userId: string,
    key: 'can_manage_products' | 'can_record_movements' | 'can_view_finance',
    value: boolean
  ) {
    setMembers(prev =>
      prev.map(member =>
        member.user_id === userId ? { ...member, [key]: value } : member
      )
    );
  }

  async function loadData(bid = business?.id, wid = warehouse?.id) {
    if (!supabase || !bid) return;

    setBusy(true);

    try {
      let query = supabase
        .from('products')
        .select('*')
        .eq('business_id', bid)
        .eq('active', true)
        .order('name');

      if (wid) query = query.eq('warehouse_id', wid);

      const { data, error } = await query;
      if (error) throw error;

      setProducts((data || []) as Product[]);

      if (wid) {
        const { data: movementRows, error: movementError } = await supabase
          .from('inventory_movements')
          .select('*')
          .eq('business_id', bid)
          .eq('warehouse_id', wid)
          .order('created_at', { ascending: false })
          .limit(100);

        if (movementError) throw movementError;
        setMoves((movementRows || []) as Move[]);
      } else {
        setMoves([]);
      }
    } catch (e: any) {
      setErr(e.message || 'Error cargando información.');
    } finally {
      setBusy(false);
    }
  }

  async function signIn(e: FormEvent) {
    e.preventDefault();
    if (!supabase) return;

    setBusy(true);
    setErr('');

    const result =
      authMode === 'login'
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({
            email,
            password,
            options: { data: { full_name: fullName } }
          });

    setBusy(false);

    if (result.error) {
      setErr(result.error.message);
    } else if (authMode === 'signup' && !result.data.session) {
      setNotice('Cuenta creada. Revisa tu correo para confirmar y después inicia sesión.');
    }
  }

  async function createWorkspace(e: FormEvent) {
    e.preventDefault();
    if (!supabase) return;

    setBusy(true);
    setErr('');

    const { data, error } = await supabase.rpc('create_business_with_warehouse', {
      p_business_name: bizName,
      p_warehouse_name: whName
    });

    setBusy(false);

    if (error) {
      setErr(error.message);
      return;
    }

    setCreatedCode(data?.warehouse_code || '');
    setTab('warehouse');
    setNotice('Negocio y almacén creados correctamente. Guarda el código para compartirlo.');
    await loadWorkspace();
  }

  async function joinWorkspace(e: FormEvent) {
    e.preventDefault();
    if (!supabase) return;

    setBusy(true);
    setErr('');

    const { error } = await supabase.rpc('join_warehouse_by_code', {
      p_code: joinCode.trim().toUpperCase()
    });

    setBusy(false);

    if (error) {
      setErr(error.message);
      return;
    }

    setNotice('Te has unido al almacén correctamente.');
    await loadWorkspace();
  }

  async function saveProduct(e: FormEvent) {
    e.preventDefault();

    if (!supabase || !business || !warehouse) return;

    setBusy(true);
    setErr('');

    try {
      const sale = form.sale_price.trim() === '' ? null : Number(form.sale_price);
      const cost = form.cost_price.trim() === '' ? null : Number(form.cost_price);
      const initialStock = Number(form.stock || 0);
      const minStock = Number(form.min_stock || 0);

      if (
        (sale !== null && (!Number.isFinite(sale) || sale < 0)) ||
        (cost !== null && (!Number.isFinite(cost) || cost < 0))
      ) {
        throw new Error('Los precios deben ser válidos y no negativos.');
      }

      if (
        !Number.isFinite(initialStock) ||
        initialStock < 0 ||
        !Number.isFinite(minStock) ||
        minStock < 0
      ) {
        throw new Error(
          'El stock inicial y el stock mínimo deben ser válidos y no negativos.'
        );
      }

      const { error } = await supabase.rpc(
        'create_product_with_initial_stock',
        {
          p_business_id: business.id,
          p_warehouse_id: warehouse.id,
          p_name: form.name.trim(),
          p_category: form.category.trim() || 'General',
          p_unit: form.unit,
          p_initial_stock: initialStock,
          p_code: form.code.trim() || null,
          p_location: form.location.trim() || null,
          p_barcode: form.barcode.trim() || null,
          p_supplier: form.supplier.trim() || null,
          p_sale_price: sale,
          p_cost_price: cost,
          p_min_stock: minStock,
          p_description: form.description.trim() || null,
          p_active: true
        }
      );

      if (error) throw error;

      setProductModal(false);
      setForm({
        name: '',
        code: '',
        category: 'General',
        location: '',
        barcode: '',
        supplier: '',
        sale_price: '',
        cost_price: '',
        stock: '0',
        unit: 'Pieza',
        min_stock: '0',
        description: ''
      });

      setNotice('Producto guardado con su stock inicial registrado.');
      await loadData(business.id, warehouse.id);
    } catch (e: any) {
      setErr(e.message || 'No se pudo guardar el producto.');
    } finally {
      setBusy(false);
    }
  }

  async function saveMovement(e: FormEvent) {
    e.preventDefault();

    if (!supabase || !moveModal) return;

    setBusy(true);
    setErr('');

    try {
      const quantity = Number(moveForm.quantity);

      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new Error('La cantidad debe ser mayor que cero.');
      }

      const { error } = await supabase.rpc('record_inventory_movement', {
        p_product_id: moveForm.product_id,
        p_movement_type: moveModal,
        p_quantity: quantity,
        p_reason: moveForm.reason,
        p_notes: moveForm.notes.trim() || null
      });

      if (error) throw error;

      setMoveModal(null);
      setMoveForm({
        product_id: '',
        quantity: '1',
        reason: 'Compra a proveedor',
        notes: ''
      });

      setNotice('Movimiento registrado correctamente.');

      if (business && warehouse) {
        await loadData(business.id, warehouse.id);
      }
    } catch (e: any) {
      setErr(e.message || 'No se pudo registrar el movimiento.');
    } finally {
      setBusy(false);
    }
  }

  async function exportMovementPdf() {
    if (!supabase || !business || !warehouse) return;

    setBusy(true);
    setErr('');

    try {
      let start = reportStart;
      let end = reportEnd;

      const now = new Date();
      const iso = (date: Date) => {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
      };

      if (reportPeriod === 'day') {
        start = end = iso(now);
      } else if (reportPeriod === 'week') {
        const first = new Date(now);
        first.setDate(first.getDate() - ((first.getDay() + 6) % 7));
        start = iso(first);

        const last = new Date(first);
        last.setDate(last.getDate() + 6);
        end = iso(last);
      } else if (reportPeriod === 'month') {
        start = iso(new Date(now.getFullYear(), now.getMonth(), 1));
        end = iso(new Date(now.getFullYear(), now.getMonth() + 1, 0));
      }

      if (!start || !end || start > end) {
        throw new Error('Selecciona un rango de fechas válido.');
      }

      const from = new Date(`${start}T00:00:00`).toISOString();
      const until = new Date(`${end}T00:00:00`);
      until.setDate(until.getDate() + 1);

      const { data, error } = await supabase
        .from('inventory_movements')
        .select('*')
        .eq('business_id', business.id)
        .eq('warehouse_id', warehouse.id)
        .eq('movement_type', 'exit')
        .gte('created_at', from)
        .lt('created_at', until.toISOString())
        .order('created_at', { ascending: true });

      if (error) throw error;

      const rows = (data || []) as Move[];
      const doc = new jsPDF({
        orientation: 'landscape',
        unit: 'mm',
        format: 'a4'
      });

      doc.setFillColor(22, 39, 65);
      doc.rect(0, 0, 297, 34, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(20);
      doc.text('BMH INVENTARIO', 14, 14);
      doc.setFontSize(10);
      doc.setFont('helvetica', 'normal');
      doc.text('REPORTE DE SALIDAS DE ALMACÉN', 14, 22);
      doc.text(`${business.name} · ${warehouse.name}`, 14, 28);

      doc.setTextColor(35, 45, 60);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(12);
      doc.text(`Periodo: ${start} al ${end}`, 14, 43);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.text(
        `Generado: ${new Date().toLocaleString('es-MX')} | Registros: ${rows.length}`,
        14,
        49
      );

      const total = rows.reduce((sum, movement) => sum + Number(movement.quantity || 0), 0);
      doc.setFont('helvetica', 'bold');
      doc.text(
        `Cantidad total de unidades registradas: ${total.toLocaleString('es-MX', { maximumFractionDigits: 3 })}`,
        14,
        56
      );

      autoTable(doc, {
        startY: 62,
        head: [[
          'Fecha y hora', 'Producto', 'Cantidad', 'Unidad', 'Motivo',
          'Registró', 'Existencia anterior', 'Existencia posterior', 'Notas'
        ]],
        body: rows.map(m => [
          new Date(m.created_at).toLocaleString('es-MX'),
          m.product_name || products.find(p => p.id === m.product_id)?.name || 'Producto',
          String(m.quantity),
          m.unit || products.find(p => p.id === m.product_id)?.unit || '',
          m.reason || '',
          m.user_name || 'Usuario sin nombre',
          String(m.stock_before),
          String(m.stock_after),
          m.notes || ''
        ]),
        styles: { fontSize: 7, cellPadding: 2, overflow: 'linebreak' },
        headStyles: { fillColor: [22, 39, 65], textColor: 255, fontStyle: 'bold' },
        alternateRowStyles: { fillColor: [242, 246, 250] },
        margin: { left: 14, right: 14 },
        didDrawPage: () => {
          doc.setFontSize(8);
          doc.setTextColor(100);
          doc.text('BMH Suministros · Reporte interno de movimientos', 14, 202);
          doc.text(`Página ${doc.getNumberOfPages()}`, 283, 202, { align: 'right' });
        }
      });

      doc.save(`BMH_Salidas_${start}_${end}.pdf`);
      setNotice(`PDF generado: ${rows.length} salidas encontradas.`);
    } catch (e: any) {
      setErr(e.message || 'No se pudo generar el PDF.');
    } finally {
      setBusy(false);
    }
  }

  const filtered = useMemo(
    () =>
      products.filter(p =>
        [p.name, p.code, p.category, p.location, p.barcode, p.supplier].some(value =>
          String(value || '').toLowerCase().includes(search.toLowerCase())
        )
      ),
    [products, search]
  );

  const stockValue = products.reduce(
    (sum, p) => sum + (p.cost_price === null ? 0 : Number(p.stock) * Number(p.cost_price)),
    0
  );

  const potential = products.reduce(
    (sum, p) => sum + (p.sale_price === null ? 0 : Number(p.stock) * Number(p.sale_price)),
    0
  );

  const missingCost = products.filter(p => p.cost_price === null).length;
  const low = products.filter(p => Number(p.stock) <= Number(p.min_stock));

  if (!configured) {
    return (
      <main className="center">
        <section className="auth card">
          <div className="brandmark">B</div>
          <h1>Conecta BMH con Supabase</h1>
          <p>Configura las variables de entorno para conectar la aplicación.</p>
          <ol>
            <li>Copia <code>.env.example</code> como <code>.env.local</code>.</li>
            <li>Completa la URL y la clave publicable.</li>
            <li>Reinicia el servidor con <code>npm run dev</code>.</li>
          </ol>
          <p className="muted">No pongas claves secretas ni service_role en el navegador.</p>
        </section>
      </main>
    );
  }

  if (loading) return <main className="center">Cargando BMH Inventario…</main>;

  if (!session) {
    return (
      <main className="center">
        <section className="auth card">
          <div className="brandmark">B</div>
          <p className="eyebrow">BMH SUMINISTROS</p>
          <h1>{authMode === 'login' ? 'Bienvenido de nuevo' : 'Crear cuenta'}</h1>
          <p className="muted">Inventario profesional para tu negocio.</p>

          <form onSubmit={signIn} className="stack">
            {authMode === 'signup' && (
              <label>
                Nombre completo
                <input value={fullName} onChange={e => setFullName(e.target.value)} required />
              </label>
            )}
            <label>
              Correo electrónico
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} required />
            </label>
            <label>
              Contraseña
              <input
                type="password"
                minLength={6}
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
              />
            </label>
            <button className="primary" disabled={busy}>
              {busy ? 'Procesando…' : authMode === 'login' ? 'Iniciar sesión' : 'Crear cuenta'}
            </button>
          </form>

          <button
            className="link"
            onClick={() => {
              setAuthMode(authMode === 'login' ? 'signup' : 'login');
              setErr('');
            }}
          >
            {authMode === 'login' ? '¿Nuevo en BMH? Crear cuenta' : 'Ya tengo cuenta. Iniciar sesión'}
          </button>

          {err && <p className="error">{err}</p>}
          {notice && <p className="success">{notice}</p>}
        </section>
      </main>
    );
  }

  if (!business) {
    return (
      <main className="center">
        <section className="auth card">
          <div className="brandmark">B</div>
          <p className="eyebrow">CONFIGURACIÓN INICIAL</p>
          <h1>Empieza con tu almacén</h1>
          <p className="muted">Crea un almacén nuevo o únete a uno existente con su código.</p>

          <div className="tabs">
            <button
              type="button"
              className={workspaceMode === 'create' ? 'primary' : 'secondary'}
              onClick={() => { setWorkspaceMode('create'); setErr(''); }}
            >
              Crear almacén
            </button>
            <button
              type="button"
              className={workspaceMode === 'join' ? 'primary' : 'secondary'}
              onClick={() => { setWorkspaceMode('join'); setErr(''); }}
            >
              Unirme con código
            </button>
          </div>

          {workspaceMode === 'create' ? (
            <form onSubmit={createWorkspace} className="stack">
              <label>
                Nombre del negocio
                <input value={bizName} onChange={e => setBizName(e.target.value)} required minLength={2} />
              </label>
              <label>
                Nombre del almacén
                <input value={whName} onChange={e => setWhName(e.target.value)} required />
              </label>
              <button className="primary" disabled={busy}>
                {busy ? 'Creando…' : 'Crear negocio y almacén'}
              </button>
            </form>
          ) : (
            <form onSubmit={joinWorkspace} className="stack">
              <label>
                Código del almacén
                <input
                  autoCapitalize="characters"
                  value={joinCode}
                  onChange={e => setJoinCode(e.target.value.toUpperCase())}
                  placeholder="BMH-XXXXXXXX"
                  required
                  minLength={5}
                />
              </label>
              <p className="tiny muted">El código se valida con Supabase y tu usuario quedará registrado como integrante.</p>
              <button className="primary" disabled={busy}>
                {busy ? 'Validando código…' : 'Unirme al almacén'}
              </button>
            </form>
          )}

          {createdCode && (
            <div className="notice">
              Código de tu almacén: <b>{createdCode}</b> · Compártelo solo con personas autorizadas.
            </div>
          )}

          <button className="link" onClick={() => supabase?.auth.signOut()}>Cerrar sesión</button>
          {err && <p className="error">{err}</p>}
          {notice && <p className="success">{notice}</p>}
        </section>
      </main>
    );
  }

  const nav = [
    ['dashboard', 'Panel principal', LayoutDashboard],
    ['products', 'Catálogo de productos', Package],
    ['entry', 'Entradas', ArrowDownToLine],
    ['exit', 'Salidas', ArrowUpFromLine],
    ['history', 'Historial de movimientos', History],
    ['reports', 'Reportes PDF', FileText],
    ['finance', 'Resumen financiero', Wallet],
    ['warehouse', 'Mi almacén', Warehouse],
    ['options', 'Opciones', Settings],
    ['members', 'Usuarios y permisos', Users]
  ] as const;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="logo">
          <div className="brandmark small">B</div>
          <div><b>BMH Inventario</b><small>Suministros</small></div>
        </div>

        <div className="business-tag">
          <Warehouse size={16} />
          <div><b>{business.name}</b><small>{warehouse?.name || 'Sin almacén'}</small></div>
        </div>

        <nav>
          {nav.map(([id, label, Icon]) => (
            <button
              key={id}
              className={tab === id ? 'active' : ''}
              onClick={() => {
                if (id === 'entry' || id === 'exit') {
                  setMoveModal(id);
                  setTab(id);
                } else {
                  setTab(id);
                }
              }}
            >
              <Icon size={18} />{label}
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <span><ShieldCheck size={15} /> Sesión protegida</span>
          <button onClick={() => supabase?.auth.signOut()}><LogOut size={17} /> Cerrar sesión</button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <p className="eyebrow">PANEL DE CONTROL</p>
            <h1>{nav.find(n => n[0] === tab)?.[1] || 'BMH Inventario'}</h1>
          </div>
          <div className="top-actions">
            <button
              className="iconbtn"
              title={darkMode ? 'Activar modo claro' : 'Activar modo oscuro'}
              onClick={() => setDarkMode(!darkMode)}
            >
              {darkMode ? <Sun size={17} /> : <Moon size={17} />}
            </button>
            <button className="iconbtn" title="Actualizar" onClick={() => loadData()}>
              <RefreshCw size={17} />
            </button>
            <span className="user-pill">{session.user.email}</span>
          </div>
        </header>

        {err && (
          <div className="alert">
            <AlertTriangle size={18} />{err}
            <button onClick={() => setErr('')}>×</button>
          </div>
        )}
        {notice && (
          <div className="notice">
            {notice}<button onClick={() => setNotice('')}>×</button>
          </div>
        )}

        {tab === 'dashboard' && (
          <>
            <div className="welcome">
              <div><h2>Tu inventario, bajo control.</h2><p>Resumen actualizado desde tu base de datos.</p></div>
              <button className="primary" onClick={() => setProductModal(true)}><Plus size={17} /> Nuevo producto</button>
            </div>

            <div className="stats">
              <Stat label="Productos activos" value={products.length.toLocaleString('es-MX')} note="En este almacén" />
              <Stat label="Valor al costo" value={money(stockValue)} note={missingCost ? `${missingCost} productos sin costo` : 'Con costos registrados'} />
              <Stat label="Valor potencial de venta" value={money(potential)} note="No representa utilidad realizada" />
              <Stat label="Stock bajo" value={String(low.length)} note="En mínimo o por debajo" warning={low.length > 0} />
            </div>

            <div className="grid2">
              <section className="card">
                <div className="section-head">
                  <div><h3>Productos con stock bajo</h3><p>Revisa lo que necesita reposición.</p></div>
                  <button className="textbtn" onClick={() => setTab('products')}>Ver catálogo →</button>
                </div>
                {low.length === 0 ? <Empty text="No hay productos con stock bajo." /> : (
                  <div className="table-wrap">
                    <table>
                      <thead><tr><th>Producto</th><th>Existencia</th><th>Mínimo</th></tr></thead>
                      <tbody>
                        {low.slice(0, 6).map(p => (
                          <tr key={p.id}>
                            <td><b>{p.name}</b><small>{p.code || 'Sin código'}</small></td>
                            <td><span className="lowbadge">{p.stock} {p.unit}</span></td>
                            <td>{p.min_stock} {p.unit}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <section className="card">
                <div className="section-head">
                  <div><h3>Movimientos recientes</h3><p>Últimos cambios de existencias.</p></div>
                  <button className="textbtn" onClick={() => setTab('history')}>Ver historial →</button>
                </div>
                <MovementList moves={moves.slice(0, 6)} products={products} />
              </section>
            </div>
          </>
        )}

        {tab === 'products' && (
          <section className="card">
            <div className="section-head">
              <div><h3>Catálogo de productos</h3><p>{products.length} productos registrados</p></div>
              <button className="primary" onClick={() => setProductModal(true)}><Plus size={17} /> Nuevo producto</button>
            </div>
            <div className="searchbar">
              <Search size={18} />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Buscar nombre, código, categoría, ubicación o proveedor…"
              />
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Producto</th><th>Ubicación</th><th>Existencia</th><th>Precio venta</th><th>Costo</th><th>Estado</th></tr></thead>
                <tbody>
                  {filtered.map(p => (
                    <tr key={p.id}>
                      <td><b>{p.name}</b><small>{p.code || 'Sin código'} · {p.category}</small></td>
                      <td>{p.location || '—'}</td>
                      <td><b>{p.stock} {p.unit}</b>{p.stock <= p.min_stock && <small className="red">Stock bajo</small>}</td>
                      <td>{money(p.sale_price)}</td>
                      <td>{money(p.cost_price)}</td>
                      <td><span className="status">Activo</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filtered.length === 0 && <Empty text="No hay productos que coincidan con la búsqueda." />}
            </div>
          </section>
        )}

        {(tab === 'entry' || tab === 'exit') && (
          <section className="card">
            <h3>{tab === 'entry' ? 'Registrar entrada' : 'Registrar salida'}</h3>
            <p className="muted">Los movimientos actualizan las existencias en una transacción segura en PostgreSQL.</p>
            <button className="primary" onClick={() => setMoveModal(tab as 'entry' | 'exit')}>
              <Plus size={17} />{tab === 'entry' ? 'Nueva entrada' : 'Nueva salida'}
            </button>
          </section>
        )}

        {tab === 'history' && (
          <section className="card">
            <div className="section-head">
              <div><h3>Historial de movimientos</h3><p>Los movimientos registrados no se editan ni se borran desde la aplicación.</p></div>
            </div>
            <MovementList moves={moves} products={products} detailed />
          </section>
        )}

        {tab === 'reports' && (
          <section className="card">
            <div className="section-head">
              <div><h3>Reporte de salidas en PDF</h3><p>Genera un documento para imprimir o compartir.</p></div>
              <FileText size={28} />
            </div>
            <div className="tabs">
              <button className={reportPeriod === 'day' ? 'primary' : 'secondary'} onClick={() => setReportPeriod('day')}>Hoy</button>
              <button className={reportPeriod === 'week' ? 'primary' : 'secondary'} onClick={() => setReportPeriod('week')}>Esta semana</button>
              <button className={reportPeriod === 'month' ? 'primary' : 'secondary'} onClick={() => setReportPeriod('month')}>Este mes</button>
              <button className={reportPeriod === 'custom' ? 'primary' : 'secondary'} onClick={() => setReportPeriod('custom')}>Personalizado</button>
            </div>
            {reportPeriod === 'custom' && (
              <div className="formgrid">
                <label>Desde<input type="date" value={reportStart} onChange={e => setReportStart(e.target.value)} /></label>
                <label>Hasta<input type="date" value={reportEnd} onChange={e => setReportEnd(e.target.value)} /></label>
              </div>
            )}
            <div className="alert info">El PDF incluye solo salidas del almacén seleccionado. No modifica el inventario.</div>
            <button className="primary" disabled={busy} onClick={exportMovementPdf}>
              <FileText size={17} />{busy ? 'Preparando PDF…' : 'Generar y descargar PDF'}
            </button>
          </section>
        )}

        {tab === 'finance' && (
          <>
            <div className="alert info">
              <Wallet size={18} /> El valor al costo solo considera productos con costo registrado. No equivale a una valuación contable o fiscal oficial.
            </div>
            <div className="stats">
              <Stat label="Valor registrado al costo" value={money(stockValue)} note={`${products.filter(p => p.cost_price !== null).length} productos con costo`} />
              <Stat label="Valor potencial de venta" value={money(potential)} note={`${products.filter(p => p.sale_price !== null).length} productos con precio`} />
              <Stat label="Diferencia potencial" value={money(potential - stockValue)} note="No es utilidad realizada" />
              <Stat label="Datos incompletos" value={String(missingCost)} note="Productos sin costo de compra" warning={missingCost > 0} />
            </div>
            <section className="card">
              <div className="section-head">
                <div><h3>Valuación por producto</h3><p>Importes estimados según existencia y precios registrados.</p></div>
                <button className="secondary" onClick={() => {
                  const rows = [
                    ['Producto', 'Código', 'Existencia', 'Unidad', 'Costo unitario', 'Precio venta', 'Valor al costo', 'Valor potencial venta'],
                    ...products.map(p => [
                      p.name, p.code || '', p.stock, p.unit, p.cost_price ?? '', p.sale_price ?? '',
                      p.cost_price === null ? '' : Number(p.stock) * Number(p.cost_price),
                      p.sale_price === null ? '' : Number(p.stock) * Number(p.sale_price)
                    ])
                  ];
                  const csv = '\ufeff' + rows.map(r => r.map(x => '"' + String(x).replace(/"/g, '""') + '"').join(',')).join('\r\n');
                  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = 'BMH_resumen_financiero.csv';
                  a.click();
                  URL.revokeObjectURL(url);
                }}>Exportar CSV</button>
              </div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Producto</th><th>Existencia</th><th>Costo unitario</th><th>Precio venta</th><th>Valor al costo</th><th>Valor potencial</th></tr></thead>
                  <tbody>
                    {products.map(p => (
                      <tr key={p.id}>
                        <td>{p.name}</td><td>{p.stock} {p.unit}</td><td>{money(p.cost_price)}</td><td>{money(p.sale_price)}</td>
                        <td>{p.cost_price === null ? 'Sin dato' : money(p.stock * Number(p.cost_price))}</td>
                        <td>{p.sale_price === null ? 'Sin dato' : money(p.stock * Number(p.sale_price))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}

        {tab === 'options' && (
          <section className="card">
            <div className="section-head">
              <div><h3>Opciones del sistema</h3><p>Preferencias y categorías del almacén.</p></div>
              <Settings size={26} />
            </div>
            <div className="settings-row">
              <div><b>Apariencia</b><p>Selecciona una interfaz cómoda para tu trabajo.</p></div>
              <button className="secondary" onClick={() => setDarkMode(!darkMode)}>
                {darkMode ? <Sun size={16} /> : <Moon size={16} />}
                {darkMode ? 'Usar modo claro' : 'Usar modo oscuro'}
              </button>
            </div>
            <div className="settings-row">
              <div><b>Categorías del almacén</b><p>Las categorías nuevas se guardan en Supabase.</p></div>
              <form className="category-add" onSubmit={async e => {
                e.preventDefault();
                if (!supabase || !business || !warehouse || !newCategory.trim()) return;

                setBusy(true);
                setErr('');
                const name = newCategory.trim();

                const { error } = await supabase.from('product_categories').insert({
                  business_id: business.id,
                  warehouse_id: warehouse.id,
                  name,
                  created_by: session.user.id
                });

                setBusy(false);

                if (error) {
                  setErr(error.message);
                  return;
                }

                setCategories(prev => Array.from(new Set([...prev, name])).sort((a, b) => a.localeCompare(b)));
                setNewCategory('');
                setNotice('Categoría guardada en Supabase.');
              }}>
                <input value={newCategory} onChange={e => setNewCategory(e.target.value)} placeholder="Ej. Tornillería" maxLength={80} required />
                <button className="primary" disabled={busy}><Plus size={16} /> Agregar</button>
              </form>
            </div>
            <div className="category-chips">
              {categories.map(category => <span key={category}><Tags size={14} />{category}</span>)}
            </div>
            <div className="alert info"><ShieldCheck size={18} /> No compartas claves secretas de Supabase.</div>
          </section>
        )}

        {tab === 'members' && (
          <section className="card">
            <div className="section-head">
              <div><h3>Usuarios y permisos</h3><p>Controla qué puede hacer cada integrante del negocio.</p></div>
              <UserCog size={26} />
            </div>
            {business.created_by !== session.user.id ? (
              <div className="alert info">Solo el creador del negocio puede administrar los permisos.</div>
            ) : (
              <div className="alert info">Los cambios de permisos se validan en Supabase.</div>
            )}
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Usuario</th><th>Rol</th><th>Administrar productos</th><th>Registrar movimientos</th><th>Ver finanzas</th><th>Acción</th></tr>
                </thead>
                <tbody>
                  {members.map(m => {
                    const isOwner = m.user_id === business.created_by;
                    return (
                      <tr key={m.user_id}>
                        <td><b>{m.full_name}</b><small>{m.user_id === session.user.id ? 'Tu cuenta' : 'Miembro del almacén'}</small></td>
                        <td><span className="status">{isOwner ? 'Jefe' : m.role === 'admin' ? 'Administrador' : 'Operativo'}</span></td>
                        <td><input aria-label={`Administrar productos para ${m.full_name}`} type="checkbox" checked={isOwner || m.can_manage_products} disabled={isOwner || business.created_by !== session.user.id} onChange={e => updateMemberPermission(m.user_id, 'can_manage_products', e.target.checked)} /></td>
                        <td><input aria-label={`Registrar movimientos para ${m.full_name}`} type="checkbox" checked={isOwner || m.can_record_movements} disabled={isOwner || business.created_by !== session.user.id} onChange={e => updateMemberPermission(m.user_id, 'can_record_movements', e.target.checked)} /></td>
                        <td><input aria-label={`Ver finanzas para ${m.full_name}`} type="checkbox" checked={isOwner || m.can_view_finance} disabled={isOwner || business.created_by !== session.user.id} onChange={e => updateMemberPermission(m.user_id, 'can_view_finance', e.target.checked)} /></td>
                        <td>
                          {isOwner ? <span className="muted">Propietario</span> : (
                            <button
                              className="secondary"
                              disabled={business.created_by !== session.user.id || savingMember === m.user_id}
                              onClick={() => saveMemberPermissions(m)}
                            >
                              <Save size={15} />{savingMember === m.user_id ? 'Guardando…' : 'Guardar'}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {members.length === 0 && <tr><td colSpan={6}>No se encontraron integrantes.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {tab === 'warehouse' && (
          <section className="card warehouse-card">
            <div className="warehouse-icon"><Warehouse size={30} /></div>
            <h2>{warehouse?.name || 'Almacén'}</h2>
            <p className="muted">Código de identificación del almacén</p>
            <div className="warehouse-code">{warehouse?.code || 'Sin código'}</div>
            <p className="muted">Este código identifica el almacén, pero no concede acceso por sí solo.</p>
            <div className="stats single">
              <Stat label="Productos" value={String(products.length)} note="Productos activos" />
              <Stat label="Movimientos" value={String(moves.length)} note="Últimos registros" />
            </div>
          </section>
        )}

        <footer>BMH Inventario · Datos sincronizados con Supabase · MXN</footer>
      </main>

      {productModal && (
        <Modal title="Nuevo producto" close={() => setProductModal(false)}>
          <form className="formgrid" onSubmit={saveProduct}>
            <label className="span2">Nombre del producto *
              <input required maxLength={180} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
            </label>
            <label>SKU / Código de producto
              <input value={form.code} onChange={e => setForm({ ...form, code: e.target.value })} placeholder="Código opcional" />
            </label>
            <label>Categoría
              <select value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>
                {Array.from(new Set([...categories, form.category || 'General'])).map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label>Ubicación
              <input placeholder="Pasillo A · Estante 03" value={form.location} onChange={e => setForm({ ...form, location: e.target.value })} />
            </label>
            <label>Código de barras
              <input value={form.barcode} onChange={e => setForm({ ...form, barcode: e.target.value })} />
            </label>
            <label>Proveedor
              <input value={form.supplier} onChange={e => setForm({ ...form, supplier: e.target.value })} />
            </label>
            <label>Unidad
              <select value={form.unit} onChange={e => setForm({ ...form, unit: e.target.value })}>
                {units.map(unit => <option key={unit}>{unit}</option>)}
              </select>
            </label>
            <label>Precio de venta (MXN)
              <input type="number" min="0" step="0.01" value={form.sale_price} onChange={e => setForm({ ...form, sale_price: e.target.value })} />
            </label>
            <label>Costo de compra (MXN)
              <input type="number" min="0" step="0.01" value={form.cost_price} onChange={e => setForm({ ...form, cost_price: e.target.value })} />
            </label>
            <label>Existencia inicial
              <input type="number" min="0" step="0.001" value={form.stock} onChange={e => setForm({ ...form, stock: e.target.value })} />
            </label>
            <label>Stock mínimo
              <input type="number" min="0" step="0.001" value={form.min_stock} onChange={e => setForm({ ...form, min_stock: e.target.value })} />
            </label>
            <label className="span2">Descripción / notas
              <textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
            </label>
            <div className="span2 modal-actions">
              <button type="button" className="secondary" onClick={() => setProductModal(false)}>Cancelar</button>
              <button className="primary" disabled={busy}>{busy ? 'Guardando…' : 'Guardar producto'}</button>
            </div>
          </form>
          <p className="tiny muted">Los precios se capturan en MXN. Este prototipo no emite comprobantes fiscales.</p>
        </Modal>
      )}

      {moveModal && (
        <Modal title={moveModal === 'entry' ? 'Registrar entrada' : 'Registrar salida'} close={() => setMoveModal(null)}>
          <form className="stack" onSubmit={saveMovement}>
            <label>Producto *
              <select required value={moveForm.product_id} onChange={e => setMoveForm({ ...moveForm, product_id: e.target.value })}>
                <option value="">Selecciona un producto</option>
                {products.map(p => <option key={p.id} value={p.id}>{p.name} · disponible: {p.stock} {p.unit}</option>)}
              </select>
            </label>
            <label>Cantidad *
              <input required type="number" min="0.001" step="0.001" value={moveForm.quantity} onChange={e => setMoveForm({ ...moveForm, quantity: e.target.value })} />
            </label>
            <label>Motivo *
              <select value={moveForm.reason} onChange={e => setMoveForm({ ...moveForm, reason: e.target.value })}>
                {['Compra a proveedor', 'Reposición de mercancía', 'Venta / pedido de cliente', 'Uso interno', 'Devolución', 'Merma / daño', 'Ajuste de inventario', 'Otro'].map(x => <option key={x}>{x}</option>)}
              </select>
            </label>
            <label>Notas
              <input value={moveForm.notes} onChange={e => setMoveForm({ ...moveForm, notes: e.target.value })} />
            </label>
            <div className="modal-actions">
              <button type="button" className="secondary" onClick={() => setMoveModal(null)}>Cancelar</button>
              <button className="primary" disabled={busy || !moveForm.product_id}>{busy ? 'Guardando…' : 'Registrar movimiento'}</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

function Stat({
  label, value, note, warning = false
}: {
  label: string;
  value: string;
  note: string;
  warning?: boolean;
}) {
  return (
    <section className="stat card">
      <span>{label}</span>
      <strong className={warning ? 'red' : ''}>{value}</strong>
      <small>{note}</small>
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="empty"><Boxes size={28} /><p>{text}</p></div>;
}

function MovementList({
  moves, products, detailed = false
}: {
  moves: Move[];
  products: Product[];
  detailed?: boolean;
}) {
  const names = new Map(products.map(p => [p.id, p.name]));

  if (!moves.length) return <Empty text="Todavía no hay movimientos registrados." />;

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Fecha</th><th>Producto</th><th>Movimiento</th><th>Cantidad</th>
            {detailed && <><th>Antes</th><th>Después</th><th>Motivo</th><th>Registró</th></>}
          </tr>
        </thead>
        <tbody>
          {moves.map(m => (
            <tr key={m.id}>
              <td>{new Date(m.created_at).toLocaleString('es-MX')}</td>
              <td>{m.product_name || names.get(m.product_id) || 'Producto archivado'}</td>
              <td>
                <span className={`movebadge ${m.movement_type}`}>
                  {m.movement_type === 'entry' ? 'Entrada' :
                   m.movement_type === 'exit' ? 'Salida' :
                   m.movement_type === 'initial' ? 'Inicial' : 'Ajuste'}
                </span>
              </td>
              <td>{m.quantity} {m.unit || ''}</td>
              {detailed && <>
                <td>{m.stock_before}</td>
                <td>{m.stock_after}</td>
                <td>{m.reason}{m.notes && <small>{m.notes}</small>}</td>
                <td>{m.user_name || 'Usuario sin nombre'}</td>
              </>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Modal({
  title, close, children
}: {
  title: string;
  close: () => void;
  children: ReactNode;
}) {
  return (
    <div className="overlay" onMouseDown={e => {
      if (e.target === e.currentTarget) close();
    }}>
      <section className="modal card">
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="close" onClick={close}>×</button>
        </div>
        {children}
      </section>
    </div>
  );
}
