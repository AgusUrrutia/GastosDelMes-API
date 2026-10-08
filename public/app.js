'use strict';

// API publicada en Vercel. La usa la app de Android, que no está en el servidor;
// también se puede cambiar desde "Servidor" en la pantalla de ingreso.
const API_REMOTA = 'https://my-proyect-jade.vercel.app/api';
const esApp = Boolean(window.Capacitor?.isNativePlatform?.());

// localStorage puede no estar disponible (modo privado); nunca debe romper la app
const guardado = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } },
};

function apiPorDefecto() {
  if (esApp) return API_REMOTA;
  // XAMPP (http://localhost/gastos/): la versión anterior de la API, en PHP
  if (location.pathname.startsWith('/gastos/')) return 'api/index.php';
  // Live Server de VS Code: la API de Node corriendo en esta PC (npm run dev en api-node)
  if (location.port === '5500') return `http://${location.hostname}:3000/api`;
  // Vercel o el servidor local de api-node: la API está en el mismo sitio
  return '/api';
}
let API = guardado.get('apiUrl') || apiPorDefecto();

const POLL_MS = 3000;     // cada cuánto se buscan cambios hechos desde otros dispositivos
const SAVE_DELAY = 500;   // espera tras dejar de tipear antes de guardar
const MESES_PROYECCION = 4;

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
  'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

const CATEGORIAS = [
  { key: 'fijo', titulo: 'Gastos fijos', color: 'var(--c-fijo)' },
  { key: 'variable', titulo: 'Gastos variables', color: 'var(--c-variable)' },
  { key: 'extra', titulo: 'Extras', color: 'var(--c-extra)' },
];

const hoy = new Date();
const state = {
  anio: hoy.getFullYear(),
  mes: hoy.getMonth() + 1,
  data: null,          // respuesta de la API para el mes visible
  serverJson: '',      // última respuesta cruda, para detectar cambios remotos
  pendientes: 0,       // guardados en curso
  version: 0,          // aumenta con cada guardado; descarta lecturas que quedaron viejas
  timers: new Map(),   // guardados programados (debounce) por campo
  renderPendiente: false,
  token: guardado.get('token'),
  usuario: null,       // usuario que inició sesión
};

const $app = document.getElementById('app');
const $sync = document.getElementById('sync');

const pesos = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
const fmt = (n) => pesos.format(Math.round(n));
const num = (v) => Number(v) || 0;
const nombreMes = (anio, mes) => `${MESES[mes - 1]} ${anio}`;
const indice = (anio, mes) => anio * 12 + (mes - 1);
const desdeIndice = (i) => ({ anio: Math.floor(i / 12), mes: (i % 12) + 1 });

// ---------- API ----------

class SesionVencida extends Error {}

async function api(action, { params = {}, body = null } = {}) {
  const qs = new URLSearchParams({ action, ...params });
  const headers = state.token ? { 'X-Token': state.token } : {};
  let res;
  try {
    res = await fetch(`${API}?${qs}`, body
      ? { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : { cache: 'no-store', headers });
  } catch {
    throw new Error(`No se pudo conectar con el servidor (${API})`);
  }
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error('Respuesta inválida del servidor'); }
  if (res.status === 401 && action !== 'login') {
    cerrarSesionLocal(json.error);
    throw new SesionVencida(json.error);
  }
  if (!res.ok) {
    const error = new Error(json.error || `Error ${res.status}`);
    error.datos = json;
    throw error;
  }
  return json;
}

function setSync(texto, clase = '') {
  $sync.textContent = texto;
  $sync.className = `sync ${clase}`;
}

async function guardar(action, body) {
  state.pendientes++;
  state.version++;
  setSync('Guardando…', 'saving');
  try {
    const r = await api(action, { body });
    return r;
  } catch (e) {
    if (!(e instanceof SesionVencida)) {
      setSync('Error al guardar', 'error');
      alert(e.message);
    }
    throw e;
  } finally {
    state.pendientes--;
    if (state.pendientes === 0 && $sync.textContent !== 'Error al guardar') setSync('Guardado ✓');
  }
}

// Guarda un campo luego de una pausa al tipear (o inmediatamente al salir del campo)
function programarGuardado(clave, action, body, inmediato = false) {
  clearTimeout(state.timers.get(clave)?.id);
  const ejecutar = () => {
    state.timers.delete(clave);
    guardar(action, body).catch(() => {});
  };
  if (inmediato) return ejecutar();
  state.timers.set(clave, { id: setTimeout(ejecutar, SAVE_DELAY), ejecutar });
}

function vaciarGuardados() {
  for (const t of [...state.timers.values()]) { clearTimeout(t.id); t.ejecutar(); }
}

// ---------- Carga y sincronización ----------

async function cargar({ forzar = false } = {}) {
  if (!state.usuario) return;
  const version = state.version;
  try {
    const data = await api('mes', { params: { anio: state.anio, mes: state.mes } });
    // El estado de caricias cambia segundo a segundo: se actualiza aparte y no
    // cuenta como un cambio que obligue a redibujar la pantalla
    const { caricias, ...resto } = data;
    actualizarCaricias(caricias);
    const json = JSON.stringify(resto);
    if (!forzar && json === state.serverJson) return;
    // No pisar lo que se está escribiendo: se aplica cuando se termine de editar
    if (!forzar && (state.pendientes > 0 || state.timers.size > 0 || version !== state.version)) return;
    state.serverJson = json;
    state.data = data;
    if (!forzar && editando()) { state.renderPendiente = true; return; }
    render();
    if (!$sync.textContent || $sync.classList.contains('error')) setSync('Sincronizado');
  } catch (e) {
    if (e instanceof SesionVencida) return;
    setSync('Sin conexión', 'error');
    if (forzar) renderError(e.message);
  }
}

// ---------- Sesión ----------

const $userBox = document.getElementById('user-box');

function cerrarSesionLocal(motivo) {
  state.token = null;
  state.usuario = null;
  state.caricias = null;
  state.data = null;
  state.serverJson = '';
  state.timers.forEach((t) => clearTimeout(t.id));
  state.timers.clear();
  guardado.set('token', null);
  renderLogin(motivo);
}

async function salir() {
  vaciarGuardados();
  try { await api('logout', { body: {} }); } catch { /* igual se cierra localmente */ }
  cerrarSesionLocal();
}

function iniciarSesion(usuario) {
  state.usuario = usuario;
  document.body.classList.remove('logged-out');
  $userBox.replaceChildren(
    h('span', { class: 'user-name' }, usuario.nombre),
    h('button', { type: 'button', class: 'link-btn', onclick: salir }, 'Salir'),
  );
  state.data = null;
  render();
  cargar({ forzar: true });
}

function renderLogin(mensaje) {
  document.body.classList.add('logged-out');
  $userBox.replaceChildren();
  setSync('');
  const err = h('p', { class: 'login-error', role: 'alert' }, mensaje || '');
  const servidor = h('input', { class: 'login-input', type: 'text', inputmode: 'url', autocapitalize: 'none', value: API, autocomplete: 'off', 'aria-label': 'Servidor' });
  const form = h('form', {
    class: 'card login',
    onsubmit: async (e) => {
      e.preventDefault();
      const datos = new FormData(form);
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      err.textContent = '';
      if (servidor.value.trim() && servidor.value.trim() !== API) {
        API = servidor.value.trim();
        guardado.set('apiUrl', API === apiPorDefecto() ? null : API);
      }
      try {
        const r = await api('login', { body: { usuario: datos.get('usuario'), password: datos.get('password') } });
        state.token = r.token;
        guardado.set('token', r.token);
        iniciarSesion(r.usuario);
      } catch (ex) {
        err.textContent = ex.message;
        btn.disabled = false;
      }
    },
  },
    h('div', { class: 'login-pet', 'aria-hidden': 'true' }, '🐶'),
    h('h2', {}, 'Ingresar'),
    h('p', { class: 'login-sub' }, 'Gastos del mes compartidos de la pareja'),
    h('label', {}, 'Usuario', h('input', { class: 'login-input', name: 'usuario', autocomplete: 'username', autocapitalize: 'none', required: true })),
    h('label', {}, 'Contraseña', h('input', { class: 'login-input', name: 'password', type: 'password', autocomplete: 'current-password', required: true })),
    err,
    h('button', { class: 'btn', type: 'submit' }, 'Ingresar'),
    h('details', { class: 'login-server' },
      h('summary', {}, 'Servidor'),
      h('label', {}, 'Dirección de la API', servidor),
      h('p', { class: 'hint' }, 'La PC con XAMPP tiene que estar prendida y el celular en el mismo Wi-Fi.')),
  );
  $app.replaceChildren(form);
  form.querySelector('[name=usuario]').focus();
}

// Al abrir: si hay una sesión guardada se retoma (y cuenta como un ingreso)
async function arrancar() {
  if (!state.token) return renderLogin();
  try {
    const r = await api('sesion', { body: { ingreso: true } });
    iniciarSesion(r.usuario);
  } catch (e) {
    if (!(e instanceof SesionVencida)) renderLogin(e.message);
  }
}

function editando() {
  const el = document.activeElement;
  return el && $app.contains(el) && el.tagName === 'INPUT';
}

$app.addEventListener('focusout', () => {
  setTimeout(() => {
    if (state.renderPendiente && !editando()) { state.renderPendiente = false; render(); }
  }, 0);
});

setInterval(() => { if (!document.hidden) cargar(); }, POLL_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) cargar(); });
window.addEventListener('beforeunload', vaciarGuardados);

function cambiarMes(delta) {
  vaciarGuardados();
  const d = desdeIndice(indice(state.anio, state.mes) + delta);
  state.anio = d.anio;
  state.mes = d.mes;
  state.data = null;
  state.serverJson = '';
  render();
  cargar({ forzar: true });
}

document.getElementById('prev').addEventListener('click', () => cambiarMes(-1));
document.getElementById('next').addEventListener('click', () => cambiarMes(1));

// ---------- Cálculos ----------

// Cuotas que corresponden a un mes dado, con su número de cuota
function cuotasDelMes(cuotas, anio, mes) {
  const i = indice(anio, mes);
  return cuotas
    .map((c) => ({ ...c, numero: i - indice(+c.anio_inicio, +c.mes_inicio) + 1 }))
    .filter((c) => c.numero >= 1 && c.numero <= +c.total_cuotas);
}

const esPagado = (g) => Number(g.pagado) === 1;
const pagoDeCuota = (c) => state.data.cuotas_pagadas.find((p) => String(p.cuota_id) === String(c.id));
const cuotaPagada = (c) => Boolean(pagoDeCuota(c));
// Nombre de un integrante de la pareja a partir de su id
const nombreDe = (id) => state.data?.ranking?.find((u) => String(u.id) === String(id))?.nombre || '';

function calcular() {
  const { mes, gastos, cuotas } = state.data;
  const t = { fijo: 0, variable: 0, extra: 0 };
  const cat = {};
  CATEGORIAS.forEach((c) => { cat[c.key] = { maximo: 0, gastado: 0, pagados: 0, items: 0 }; });
  let maximo = 0;
  let gastado = 0;
  gastos.forEach((g) => {
    t[g.categoria] += num(g.maximo);
    const c = cat[g.categoria];
    c.maximo += num(g.maximo);
    c.gastado += num(g.gastado);
    c.items++;
    if (esPagado(g)) c.pagados++;
    maximo += num(g.maximo);
    gastado += num(g.gastado);
  });
  const activas = cuotasDelMes(cuotas, state.anio, state.mes);
  const cuota = activas.reduce((s, c) => s + num(c.monto_cuota), 0);
  const cuotaPag = activas.filter(cuotaPagada).reduce((s, c) => s + num(c.monto_cuota), 0);
  const ingreso = num(mes.ingreso);
  const ahorro = num(mes.ahorro);
  // Dos cálculos: lo planificado (montos máximos + todas las cuotas del mes)
  // y lo real (montos gastados + cuotas tildadas como pagadas)
  const presupuesto = maximo + cuota;
  const real = gastado + cuotaPag;
  return {
    ...t, cat, cuota, ingreso, ahorro,
    cuotasPagadas: activas.filter(cuotaPagada).length, cuotasActivas: activas.length,
    presupuesto,
    gastado: real,
    porGastar: presupuesto - real,
    restoMaximo: ingreso - presupuesto - ahorro,
    restoReal: ingreso - real - ahorro,
  };
}

// ---------- Render ----------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) el.append(c);
  return el;
}

function render() {
  document.getElementById('month-label').textContent = nombreMes(state.anio, state.mes);
  $app.replaceChildren();
  if (!state.data) { $app.append(h('p', { class: 'hint' }, 'Cargando…')); return; }
  if (!state.data.mes) { renderVacio(); return; }

  $app.append(
    renderResumen(),
    renderMascota(),
    ...CATEGORIAS.map(renderCategoria),
    renderCuotas(),
    renderProyeccion(),
  );
  actualizarTotales();
  pintarBotonCaricia();
}

function renderError(msg) {
  $app.replaceChildren(h('div', { class: 'card empty error-box' },
    h('h2', {}, 'No se pudo conectar'),
    h('p', {}, msg),
    h('p', {}, 'Verificá que Apache y MySQL estén iniciados en el panel de XAMPP y que la base "gastos_mes" exista.'),
    h('button', { class: 'btn', onclick: () => cargar({ forzar: true }) }, 'Reintentar'),
  ));
}

function renderVacio() {
  const ant = state.data.anterior;
  const crear = async (copiar) => {
    await guardar('crear_mes', { anio: state.anio, mes: state.mes, copiar });
    cargar({ forzar: true });
  };
  $app.append(h('div', { class: 'card empty' },
    h('h2', {}, `${nombreMes(state.anio, state.mes)} todavía no tiene datos`),
    h('p', {}, ant
      ? `Podés arrancar copiando el sueldo, el ahorro y los gastos fijos y variables (con sus montos máximos) de ${nombreMes(ant.anio, ant.mes)}. Lo gastado y los pagos arrancan en cero.`
      : 'Creá el mes para empezar a cargar el ingreso y los gastos.'),
    ant && h('button', { class: 'btn', onclick: () => crear(true) }, `Copiar de ${nombreMes(ant.anio, ant.mes)}`),
    h('button', { class: `btn ${ant ? 'secondary' : ''}`, onclick: () => crear(false) }, 'Crear vacío'),
  ));
}

function inputMonto(valor, onValor, attrs = {}) {
  return h('input', {
    type: 'number', inputmode: 'decimal', step: 'any', min: '0', placeholder: '0',
    value: num(valor) ? String(num(valor)) : '', ...attrs,
    oninput: (e) => onValor(e.target.value, false),
    onchange: (e) => onValor(e.target.value, true),
  });
}

function inputTexto(valor, onValor, attrs = {}) {
  return h('input', {
    type: 'text', value: valor ?? '', ...attrs,
    oninput: (e) => onValor(e.target.value, false),
    onchange: (e) => onValor(e.target.value, true),
  });
}

function renderResumen() {
  const m = state.data.mes;
  const editarMes = (campo) => (valor, inmediato) => {
    m[campo] = valor;
    actualizarTotales();
    programarGuardado(`mes-${campo}`, 'actualizar_mes', { id: m.id, campo, valor }, inmediato);
  };

  const stat = (label, valueEl, sub, extra = '') =>
    h('div', { class: `card ${extra}` }, h('div', { class: 'stat-label' }, label), valueEl, sub);

  return h('section', {},
    h('div', { class: 'summary' },
      stat('Ingreso (sueldo)', inputMonto(m.ingreso, editarMes('ingreso'), { class: 'stat-input', 'aria-label': 'Ingreso' })),
      stat('Presupuesto', h('div', { class: 'stat-value', id: 't-presupuesto' }), h('div', { class: 'stat-sub', id: 't-presupuesto-pct' })),
      stat('Gastado', h('div', { class: 'stat-value', id: 't-gastado' }), h('div', { class: 'stat-sub', id: 't-por-gastar' })),
      stat('Ahorro', inputMonto(m.ahorro, editarMes('ahorro'), { class: 'stat-input', 'aria-label': 'Ahorro' })),
      stat('Resto según máximos', h('div', { class: 'stat-value', id: 't-resto-max' }),
        h('div', { class: 'stat-sub' }, 'Ingreso − máximos − cuotas − ahorro'), 'highlight'),
      stat('Resto real', h('div', { class: 'stat-value', id: 't-resto-real' }),
        h('div', { class: 'stat-sub' }, 'Ingreso − gastado − cuotas pagadas − ahorro'), 'highlight real'),
    ),
    h('div', { class: 'card dist' },
      h('div', { class: 'dist-bar', id: 'dist-bar' }),
      h('div', { class: 'legend', id: 'legend' }),
    ),
  );
}

// Ánimo de la mascota según las caricias de hoy de toda la pareja
function textoAnimo(ranking) {
  const total = ranking.reduce((s, u) => s + num(u.caricias_hoy), 0);
  const animo = total === 0 ? 'Te extraña… ¡acariciala!' : total < 10 ? 'Está contenta' : total < 30 ? '¡Está feliz!' : '¡Está en la gloria!';
  return `${animo} · ${total} caricias hoy`;
}

// ---------- Límite de caricias ----------
// El servidor manda cuántas caricias quedan hoy y los segundos de espera; acá se
// convierte la espera en un horario para llevar la cuenta regresiva sin consultar.
const CARICIA_ESPERA_LOCAL = 60 * 1000;

function actualizarCaricias(c) {
  if (!c) return;
  state.caricias = { ...c, hasta: Date.now() + num(c.espera) * 1000 };
  pintarBotonCaricia();
}

function puedeAcariciar() {
  const c = state.caricias;
  return Boolean(c) && num(c.restantes) > 0 && Date.now() >= c.hasta;
}

function pintarBotonCaricia() {
  const btn = document.getElementById('pet-btn');
  const info = document.getElementById('pet-limit');
  const c = state.caricias;
  if (!btn || !c) return;
  const faltan = Math.ceil((c.hasta - Date.now()) / 1000);
  if (num(c.restantes) === 0) {
    btn.textContent = '😴 Sin caricias por hoy';
  } else if (faltan > 0) {
    btn.textContent = `⏳ Esperá ${Math.floor(faltan / 60)}:${String(faltan % 60).padStart(2, '0')}`;
  } else {
    btn.textContent = '🤚 Acariciar mascota';
  }
  btn.disabled = !puedeAcariciar();
  info.textContent = `Te quedan ${c.restantes} de ${c.limite_dia} caricias hoy`;
}

setInterval(pintarBotonCaricia, 1000);

// Mascota de la pareja: cada caricia suma un punto a quien la acaricia
function renderMascota() {
  const ranking = state.data.ranking || [];
  const lider = ranking[0] && num(ranking[0].puntos) > num(ranking[1]?.puntos) ? ranking[0] : null;

  const mascota = h('div', { class: 'pet', 'aria-hidden': 'true' }, '🐶');
  const estado = h('p', { class: 'pet-mood' }, textoAnimo(ranking));
  const lista = h('ol', { class: 'ranking' });

  const pintarRanking = (filas) => {
    lista.replaceChildren(...filas.map((u, i) => h('li', { class: String(u.id) === String(state.usuario.id) ? 'yo' : null },
      h('span', { class: 'pos' }, i === 0 && lider ? '👑' : `${i + 1}`),
      h('span', { class: 'quien' }, u.nombre,
        h('small', {}, `${u.ingresos} ingresos · ${u.caricias} caricias`)),
      h('b', { class: 'pts', 'data-user': u.id }, `${u.puntos} pts`),
    )));
  };
  pintarRanking(ranking);

  const escenario = h('div', { class: 'pet-stage' }, mascota);
  const acariciar = async () => {
    if (!puedeAcariciar()) return;
    // Bloqueo inmediato del botón; el servidor confirma (o rechaza) la caricia
    state.caricias = { ...state.caricias, hasta: Date.now() + CARICIA_ESPERA_LOCAL };
    pintarBotonCaricia();
    try {
      const r = await api('acariciar', { body: {} });
      mascota.classList.remove('mimo');
      void mascota.offsetWidth;
      mascota.classList.add('mimo');
      const corazon = h('span', { class: 'heart' }, '❤️ +1');
      corazon.style.left = `${40 + Math.random() * 20}%`;
      escenario.append(corazon);
      setTimeout(() => corazon.remove(), 1000);
      state.data.ranking = r.ranking;
      actualizarCaricias(r.caricias);
      pintarRanking(r.ranking);
      estado.textContent = textoAnimo(r.ranking);
    } catch (ex) {
      if (ex.datos?.caricias) actualizarCaricias(ex.datos.caricias);
      else if (!(ex instanceof SesionVencida)) { setSync('Sin conexión', 'error'); actualizarCaricias({ ...state.caricias, espera: 0 }); }
    }
  };

  return h('section', { class: 'section' },
    h('div', { class: 'section-head' }, h('h2', {}, 'Mascota y puntajes')),
    h('div', { class: 'card pet-card' },
      h('div', { class: 'pet-side' },
        escenario,
        estado,
        h('button', { type: 'button', class: 'btn pet-btn', id: 'pet-btn', onclick: acariciar }),
        h('p', { class: 'pet-limit', id: 'pet-limit' }),
      ),
      h('div', { class: 'pet-rank' },
        h('div', { class: 'stat-label' }, 'Ranking de la pareja'),
        lista,
        h('p', { class: 'hint' }, 'Cada ingreso a la app suma 10 puntos y cada caricia, 1 (hasta 20 por día, una por minuto).'),
      ),
    ),
  );
}

function renderCategoria(cat) {
  const filas = state.data.gastos.filter((g) => g.categoria === cat.key);

  const fila = (g) => {
    const editar = (campo) => (valor, inmediato) => {
      g[campo] = valor;
      if (campo === 'maximo' || campo === 'gastado') actualizarTotales();
      programarGuardado(`g-${g.id}-${campo}`, 'actualizar_gasto', { id: g.id, campo, valor }, inmediato);
    };
    const gastadoInput = inputMonto(g.gastado, editar('gastado'), { class: 'field num c-gas', placeholder: 'Gastado', title: 'Gastado', 'aria-label': 'Gastado' });
    const row = h('div', { class: `row gasto${esPagado(g) ? ' pagado' : ''}` },
      h('label', { class: 'check c-check', title: 'Pagado' },
        h('input', {
          type: 'checkbox', checked: esPagado(g), 'aria-label': `Pagado: ${g.detalle}`,
          onchange: (e) => {
            g.pagado = e.target.checked ? 1 : 0;
            g.pagado_por = e.target.checked ? state.usuario.id : null;
            row.classList.toggle('pagado', e.target.checked);
            // Al marcar pagado sin monto gastado, se toma el máximo como gastado
            if (e.target.checked && !num(g.gastado) && num(g.maximo)) {
              gastadoInput.value = String(num(g.maximo));
              editar('gastado')(g.maximo, true);
            }
            editar('pagado')(g.pagado, true);
            actualizarTotales();
          },
        }),
        h('span', { class: 'check-box' })),
      inputTexto(g.detalle, editar('detalle'), {
        class: 'field c-det', placeholder: 'Detalle', 'data-gasto': g.id, 'aria-label': 'Detalle',
        title: g.creado_por ? `Cargado por ${nombreDe(g.creado_por)}` : null,
      }),
      inputMonto(g.maximo, editar('maximo'), { class: 'field num c-max', placeholder: 'Máximo', title: 'Monto máximo', 'aria-label': 'Monto máximo' }),
      gastadoInput,
      h('div', { class: 'progress c-prog', id: `p-${g.id}` }, h('div', { class: 'bar' }, h('span')), h('small')),
      inputTexto(g.nota, editar('nota'), { class: 'field note', placeholder: 'Nota', 'aria-label': 'Nota' }),
      h('button', {
        class: 'del', title: 'Eliminar', 'aria-label': `Eliminar ${g.detalle}`,
        onclick: async () => {
          if (!confirm(`¿Eliminar "${g.detalle || 'este gasto'}"?`)) return;
          await guardar('eliminar_gasto', { id: g.id });
          state.data.gastos = state.data.gastos.filter((x) => x !== g);
          render();
        },
      }, '✕'),
    );
    return row;
  };

  const agregar = async () => {
    const nuevo = await guardar('agregar_gasto', { mes_id: state.data.mes.id, categoria: cat.key });
    state.data.gastos.push(nuevo);
    render();
    document.querySelector(`[data-gasto="${nuevo.id}"]`)?.focus();
  };

  return h('section', { class: 'section' },
    h('div', { class: 'section-head' },
      h('h2', {}, h('i', { style: `background:${cat.color}` }), cat.titulo),
      h('span', { class: 'section-meta', id: `t-${cat.key}-pag` }),
      h('span', { class: 'section-total', id: `t-${cat.key}` }),
    ),
    h('div', { class: 'card rows' },
      filas.length
        ? [h('div', { class: 'row gasto row-head' },
            h('span', { class: 'c-check', title: 'Pagado' }, '✓'), h('span', { class: 'c-det' }, 'Detalle'),
            h('span', { class: 'c-max num' }, 'Máximo'), h('span', { class: 'c-gas num' }, 'Gastado'),
            h('span', { class: 'c-prog' }, 'Disponible'), h('span', { class: 'note' }, 'Nota'), h('span', { class: 'del' })),
          ...filas.map(fila)]
        : h('div', { class: 'empty-row' }, 'Sin gastos cargados.'),
      h('button', { class: 'add', onclick: agregar }, '+ Agregar gasto'),
    ),
  );
}

function renderCuotas() {
  const activas = cuotasDelMes(state.data.cuotas, state.anio, state.mes);

  const fila = (c) => {
    const original = state.data.cuotas.find((x) => x.id === c.id);
    const editar = (campo) => (valor, inmediato) => {
      original[campo] = valor;
      c[campo] = valor;
      actualizarTotales();
      programarGuardado(`c-${c.id}-${campo}`, 'actualizar_cuota', { id: c.id, campo, valor }, inmediato);
    };
    const fin = desdeIndice(indice(+c.anio_inicio, +c.mes_inicio) + +c.total_cuotas - 1);
    const textoPlan = () => {
      const quien = nombreDe(pagoDeCuota(c)?.pagado_por);
      return `Desde ${nombreMes(+c.anio_inicio, +c.mes_inicio)} · última en ${nombreMes(fin.anio, fin.mes)}`
        + (quien ? ` · pagó ${quien}` : '');
    };
    const plan = h('span', { class: 'note' }, textoPlan());
    const row = h('div', { class: `row cuota${cuotaPagada(c) ? ' pagado' : ''}` },
      h('label', { class: 'check c-check', title: 'Pagada' },
        h('input', {
          type: 'checkbox', checked: cuotaPagada(c), 'aria-label': `Cuota pagada: ${c.detalle}`,
          onchange: (e) => {
            const pagado = e.target.checked;
            const lista = state.data.cuotas_pagadas.filter((p) => String(p.cuota_id) !== String(c.id));
            state.data.cuotas_pagadas = pagado ? [...lista, { cuota_id: c.id, pagado_por: state.usuario.id }] : lista;
            row.classList.toggle('pagado', pagado);
            plan.textContent = textoPlan();
            actualizarTotales();
            programarGuardado(`c-${c.id}-pagado`, 'marcar_cuota',
              { cuota_id: c.id, anio: state.anio, mes: state.mes, pagado }, true);
          },
        }),
        h('span', { class: 'check-box' })),
      inputTexto(c.detalle, editar('detalle'), { class: 'field c-det', placeholder: 'Detalle', 'data-cuota': c.id, 'aria-label': 'Detalle' }),
      inputMonto(c.monto_cuota, editar('monto_cuota'), { class: 'field num c-max', 'aria-label': 'Monto de la cuota' }),
      h('span', { class: 'cuota-n' }, `Cuota ${c.numero} de`,
        h('input', {
          class: 'field', type: 'number', min: '1', max: '99', step: '1', value: c.total_cuotas, 'aria-label': 'Total de cuotas',
          onchange: (e) => {
            const v = Math.max(1, Math.min(99, parseInt(e.target.value, 10) || 1));
            original.total_cuotas = v;
            programarGuardado(`c-${c.id}-total`, 'actualizar_cuota', { id: c.id, campo: 'total_cuotas', valor: v }, true);
            render();
          },
        })),
      plan,
      h('button', {
        class: 'del', title: 'Eliminar compra en cuotas', 'aria-label': `Eliminar ${c.detalle}`,
        onclick: async () => {
          if (!confirm(`¿Eliminar "${c.detalle || 'esta compra'}" y todas sus cuotas?`)) return;
          await guardar('eliminar_cuota', { id: c.id });
          state.data.cuotas = state.data.cuotas.filter((x) => x.id !== c.id);
          render();
        },
      }, '✕'),
    );
    return row;
  };

  const agregar = async () => {
    const nueva = await guardar('agregar_cuota', {
      detalle: '', monto_cuota: 0, total_cuotas: 3, anio_inicio: state.anio, mes_inicio: state.mes,
    });
    state.data.cuotas.push(nueva);
    render();
    document.querySelector(`[data-cuota="${nueva.id}"]`)?.focus();
  };

  return h('section', { class: 'section' },
    h('div', { class: 'section-head' },
      h('h2', {}, h('i', { style: 'background:var(--c-cuota)' }), 'Cuotas'),
      h('span', { class: 'section-meta', id: 't-cuota-pag' }),
      h('span', { class: 'section-total', id: 't-cuota' }),
    ),
    h('div', { class: 'card rows' },
      activas.length
        ? [h('div', { class: 'row cuota row-head' },
            h('span', { class: 'c-check', title: 'Pagada' }, '✓'), h('span', { class: 'c-det' }, 'Detalle'),
            h('span', { class: 'c-max num' }, 'Valor cuota'), h('span', { class: 'cuota-n' }, 'Cuota'),
            h('span', { class: 'note' }, 'Plan'), h('span', { class: 'del' })),
          ...activas.map(fila)]
        : h('div', { class: 'empty-row' }, 'No hay cuotas que paguen este mes.'),
      h('button', { class: 'add', onclick: agregar }, '+ Nueva compra en cuotas'),
    ),
    h('p', { class: 'hint' }, 'Las cuotas se descuentan solas en cada mes del plan, empezando por el mes en que se cargan.'),
  );
}

function renderProyeccion() {
  return h('section', { class: 'section' },
    h('div', { class: 'section-head' }, h('h2', {}, 'Proyección próximos meses')),
    h('div', { class: 'card table-wrap' }, h('table', { class: 'proj', id: 'proj' })),
    h('p', { class: 'hint' }, 'Los meses ya creados usan sus propios datos. Los marcados como "estimado" suponen el mismo sueldo, máximos de fijos y variables y ahorro que este mes, sin extras; el cálculo real aparece cuando se crea el mes.'),
  );
}

// Actualiza solo los números (sin redibujar los campos que se están editando)
function actualizarTotales() {
  if (!state.data?.mes) return;
  const t = calcular();
  const set = (id, valor, negativo = false) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = valor;
    el.classList.toggle('negative', negativo);
  };

  set('t-presupuesto', fmt(t.presupuesto));
  set('t-presupuesto-pct', t.ingreso ? `${Math.round((t.presupuesto / t.ingreso) * 100)}% del ingreso` : '');
  set('t-gastado', fmt(t.gastado));
  set('t-por-gastar', t.porGastar >= 0 ? `Faltan ${fmt(t.porGastar)} por gastar` : `Excedido ${fmt(-t.porGastar)}`);
  set('t-resto-max', fmt(t.restoMaximo), t.restoMaximo < 0);
  set('t-resto-real', fmt(t.restoReal), t.restoReal < 0);
  CATEGORIAS.forEach((c) => {
    const k = t.cat[c.key];
    set(`t-${c.key}`, `${fmt(k.gastado)} de ${fmt(k.maximo)}`, k.gastado > k.maximo);
    set(`t-${c.key}-pag`, k.items ? `${k.pagados}/${k.items} pagados` : '');
  });
  set('t-cuota', fmt(t.cuota));
  set('t-cuota-pag', t.cuotasActivas ? `${t.cuotasPagadas}/${t.cuotasActivas} pagadas` : '');

  // Disponible de cada ítem: cuánto queda del máximo, o cuánto se excedió
  state.data.gastos.forEach((g) => {
    const el = document.getElementById(`p-${g.id}`);
    if (!el) return;
    const max = num(g.maximo);
    const gas = num(g.gastado);
    const excedido = gas > max;
    el.classList.toggle('excedido', excedido);
    el.classList.toggle('lleno', !excedido && max > 0 && gas >= max * 0.9);
    el.querySelector('.bar span').style.width = `${max ? Math.min(100, (gas / max) * 100) : (gas ? 100 : 0)}%`;
    const quien = esPagado(g) && g.pagado_por ? nombreDe(g.pagado_por) : '';
    el.querySelector('small').textContent = (excedido ? `Excedido ${fmt(gas - max)}` : `Quedan ${fmt(max - gas)}`)
      + (quien ? ` · pagó ${quien}` : '');
  });

  // Barra de distribución del ingreso
  const partes = [
    ['Fijos', t.fijo, 'var(--c-fijo)'],
    ['Variables', t.variable, 'var(--c-variable)'],
    ['Extras', t.extra, 'var(--c-extra)'],
    ['Cuotas', t.cuota, 'var(--c-cuota)'],
    ['Ahorro', t.ahorro, 'var(--c-ahorro)'],
    ['Resto', Math.max(0, t.restoMaximo), 'var(--c-resto)'],
  ];
  const base = Math.max(t.ingreso, partes.reduce((s, p) => s + p[1], 0)) || 1;
  document.getElementById('dist-bar').replaceChildren(...partes.filter((p) => p[1] > 0)
    .map(([n, v, c]) => h('span', { title: `${n}: ${fmt(v)}`, style: `width:${(v / base) * 100}%;background:${c}` })));
  document.getElementById('legend').replaceChildren(...partes.map(([n, v, c]) =>
    h('span', {}, h('i', { style: `background:${c}` }), `${n} `, h('b', {}, fmt(v)))));

  renderTablaProyeccion(t);
}

// Proyección: mes actual + próximos meses, con el cálculo según máximos y el real.
// Un mes futuro ya creado usa sus propios datos; uno sin crear se estima con los
// valores de este mes y no tiene cálculo real todavía.
function renderTablaProyeccion(t) {
  const { siguientes = [], pagadas_siguientes: pagadasSig = [] } = state.data;
  const filas = [];
  for (let k = 0; k <= MESES_PROYECCION; k++) {
    const d = desdeIndice(indice(state.anio, state.mes) + k);
    const activas = cuotasDelMes(state.data.cuotas, d.anio, d.mes);
    const cuota = activas.reduce((s, c) => s + num(c.monto_cuota), 0);
    let f;
    if (k === 0) {
      f = { ingreso: t.ingreso, fv: t.fijo + t.variable, extra: t.extra, ahorro: t.ahorro, gastado: t.gastado };
    } else {
      const m = siguientes.find((x) => +x.anio === d.anio && +x.mes === d.mes);
      if (m) {
        const cuotaPag = activas
          .filter((c) => pagadasSig.some((p) => String(p.cuota_id) === String(c.id) && +p.anio === d.anio && +p.mes === d.mes))
          .reduce((s, c) => s + num(c.monto_cuota), 0);
        f = { ingreso: num(m.ingreso), fv: num(m.fijos_variables), extra: num(m.extras), ahorro: num(m.ahorro), gastado: num(m.gastado) + cuotaPag };
      } else {
        f = { ingreso: t.ingreso, fv: t.fijo + t.variable, extra: 0, ahorro: t.ahorro, gastado: null, estimado: true };
      }
    }
    f.d = d;
    f.cuota = cuota;
    f.restoMaximo = f.ingreso - f.fv - f.extra - cuota - f.ahorro;
    f.restoReal = f.gastado == null ? null : f.ingreso - f.gastado - f.ahorro;
    filas.push(f);
  }

  const celda = (v) => (v == null
    ? h('td', { class: 'muted', title: 'Mes sin cargar' }, '—')
    : h('td', { class: v < 0 ? 'negative' : null }, fmt(v)));
  const linea = (label, key, cls) => h('tr', { class: cls }, h('td', {}, label), ...filas.map((f) => celda(f[key])));
  const grupo = (titulo) => h('tr', { class: 'group' }, h('td', { colspan: filas.length + 1 }, titulo));

  document.getElementById('proj').replaceChildren(
    h('thead', {}, h('tr', {}, h('th', {}, ''),
      ...filas.map((f, k) => h('th', {},
        k === 0 ? `${MESES[f.d.mes - 1]} (actual)` : nombreMes(f.d.anio, f.d.mes),
        f.estimado ? h('small', {}, 'estimado') : null)))),
    h('tbody', {},
      linea('Ingreso', 'ingreso'),
      linea('Ahorro', 'ahorro'),
      linea('Cuotas', 'cuota'),
      grupo('Según máximos'),
      linea('Fijos + variables', 'fv'),
      linea('Extras', 'extra'),
      linea('Resto según máximos', 'restoMaximo', 'total'),
      grupo('Real'),
      linea('Gastado (incluye cuotas pagadas)', 'gastado'),
      linea('Resto real', 'restoReal', 'total real'),
    ),
  );
}

arrancar();
