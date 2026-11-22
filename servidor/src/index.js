// Servidor de Smagsbord (by fuge1618).
// La app le deja un pedido (enlace de YouTube, enlace de una página o texto) y se puede cerrar.
// El servidor le pide la receta a Gemini y la guarda hasta que la app la pase a buscar.
import { DurableObject } from "cloudflare:workers";

const RAPIDOS = ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-flash-latest", "gemini-3-flash-preview", "gemini-3.5-flash-lite"];
const POTENTES = ["gemini-4-argon", "gemini-3.1-pro-preview"];
const BASE = "https://generativelanguage.googleapis.com/v1beta/";
const DIA = 864e5;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,X-Codigo",
  "Access-Control-Max-Age": "86400",
};
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...cors } });

// Comparación que no delata por tiempo cuántas letras del código coinciden.
function igual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (u.pathname === "/" || u.pathname === "/salud") return json({ ok: true, servicio: "smagsbord" });
    if (!env.CODIGO || !env.GEMINI_KEY) return json({ error: "Al servidor le falta configurar el código de la familia o la clave de Gemini." }, 503);
    if (!igual(req.headers.get("X-Codigo") || "", env.CODIGO)) return json({ error: "El código de la familia no coincide." }, 401);
    const cocina = env.COCINA.get(env.COCINA.idFromName("familia"));
    if (u.pathname === "/hola" && req.method === "GET") return json({ ok: true });
    if (u.pathname === "/recetas" && req.method === "POST") {
      if (Number(req.headers.get("content-length") || 0) > 200000) return json({ error: "El pedido es demasiado grande." }, 413);
      let b;
      try { b = await req.json(); } catch (_) { return json({ error: "Pedido mal formado." }, 400); }
      const p = { prompt: String(b.prompt || ""), yt: String(b.yt || ""), url: String(b.url || ""), texto: String(b.texto || ""), nivel: b.nivel === "pot" ? "pot" : "rap" };
      if (!p.prompt || (!p.yt && !p.url && !p.texto)) return json({ error: "Falta la fuente de la receta." }, 400);
      if (p.yt && !/^[\w-]{11}$/.test(p.yt)) return json({ error: "Ese enlace de YouTube no es válido." }, 400);
      return json(await cocina.pedir(p), 202);
    }
    const m = u.pathname.match(/^\/recetas\/([\w-]{8,40})$/);
    if (m && req.method === "GET") {
      const r = await cocina.ver(m[1]);
      return r ? json(r) : json({ error: "No encuentro ese pedido." }, 404);
    }
    return json({ error: "No existe." }, 404);
  },
};

export class Cocina extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS pedidos(id TEXT PRIMARY KEY, creado INTEGER, estado TEXT, pedido TEXT, salida TEXT, error TEXT, modelo TEXT, inicio INTEGER, fin INTEGER)");
  }

  async pedir(p) {
    const sql = this.ctx.storage.sql;
    const hoy = sql.exec("SELECT COUNT(*) AS n FROM pedidos WHERE creado > ?", Date.now() - DIA).one().n;
    if (hoy >= 60) return { error: "Se llegó al máximo de recetas por día." };
    const id = crypto.randomUUID();
    sql.exec("INSERT INTO pedidos(id,creado,estado,pedido) VALUES(?,?,?,?)", id, Date.now(), "pendiente", JSON.stringify(p));
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now());
    return { id, estado: "pendiente" };
  }

  async ver(id) {
    const f = this.ctx.storage.sql.exec("SELECT id,estado,salida,error,modelo,creado,inicio,fin FROM pedidos WHERE id=?", id).toArray()[0];
    if (!f) return null;
    // Un pedido que quedó trabado (el servidor se reinició a mitad de camino) vuelve a la fila.
    if (f.estado === "procesando" && Date.now() - f.inicio > 12 * 60000) {
      this.ctx.storage.sql.exec("UPDATE pedidos SET estado='pendiente' WHERE id=?", id);
      if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now());
      f.estado = "pendiente";
    }
    const o = { id: f.id, estado: f.estado };
    if (f.estado === "lista") { o.salida = f.salida; o.modelo = f.modelo; o.segundos = Math.round((f.fin - f.inicio) / 1000); }
    if (f.estado === "error") o.error = f.error;
    return o;
  }

  // La alarma es la que trabaja: puede esperar a Gemini varios minutos sin que nadie esté conectado.
  async alarm() {
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM pedidos WHERE creado < ?", Date.now() - 7 * DIA);
    const t0 = Date.now();
    for (;;) {
      const f = sql.exec("SELECT id,pedido FROM pedidos WHERE estado='pendiente' ORDER BY creado LIMIT 1").toArray()[0];
      if (!f) break;
      if (Date.now() - t0 > 8 * 60000) { await this.ctx.storage.setAlarm(Date.now() + 1000); break; }
      sql.exec("UPDATE pedidos SET estado='procesando', inicio=? WHERE id=?", Date.now(), f.id);
      try {
        const r = await this.gemini(JSON.parse(f.pedido));
        sql.exec("UPDATE pedidos SET estado='lista', salida=?, modelo=?, fin=?, pedido='' WHERE id=?", r.texto, r.modelo, Date.now(), f.id);
      } catch (e) {
        sql.exec("UPDATE pedidos SET estado='error', error=?, fin=?, pedido='' WHERE id=?", String((e && e.message) || e).slice(0, 500), Date.now(), f.id);
      }
    }
  }

  async gemini(p) {
    const partes = [{ text: p.prompt }];
    if (p.yt) partes.push({ file_data: { file_uri: "https://www.youtube.com/watch?v=" + p.yt } });
    if (p.url && !p.yt) partes.push({ text: "La receta está en esta página: " + p.url + (p.texto ? "\n" + p.texto : "") });
    else if (p.texto) partes.push({ text: "Texto que acompaña a la receta: " + p.texto });
    const cuerpo = { contents: [{ role: "user", parts: partes }] };
    if (p.url && !p.yt) cuerpo.tools = [{ url_context: {} }];
    const modelos = p.nivel === "pot" ? POTENTES.concat(RAPIDOS) : RAPIDOS;
    const base = this.env.GEMINI_BASE || BASE;
    const espera = (t) => new Promise((r) => setTimeout(r, t));
    let ult = "", sat = 0, lim = 0, red = 0;
    for (const m of modelos) {
      for (let intento = 0; intento < 2; intento++) {
        let r, j;
        try {
          r = await fetch(base + "models/" + m + ":generateContent", { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": this.env.GEMINI_KEY }, body: JSON.stringify(cuerpo), signal: AbortSignal.timeout(6 * 60000) });
          j = await r.json().catch(() => ({}));
        } catch (e) { red++; ult = "sin conexión con Gemini"; if (intento === 0) { await espera(3000); continue; } break; }
        if (r.ok) {
          const t = (((j.candidates || [])[0] || {}).content || {}).parts || [];
          const texto = t.filter((x) => typeof x.text === "string" && !x.thought).map((x) => x.text).join("");
          if (texto) return { texto, modelo: m };
          const br = j.promptFeedback && j.promptFeedback.blockReason;
          if (br) throw new Error("Gemini no quiso procesar esa fuente (" + br + ").");
          ult = "respuesta sin texto"; break;
        }
        const em = (j.error && (j.error.message || j.error.status)) || "error " + r.status;
        ult = em;
        if (r.status === 402) throw new Error("La cuenta de Gemini se quedó sin saldo. Hay que recargar crédito en Google AI Studio.");
        if (r.status === 401 || /api key/i.test(em)) throw new Error("Gemini rechazó la clave del servidor. (" + em + ")");
        if (r.status >= 500 || /overloaded|high demand|unavailable|try again later/i.test(em)) { sat++; if (intento === 0) { await espera(5000); continue; } break; }
        if (r.status === 429 || r.status === 403) { lim++; break; }
        if (r.status === 404 || (r.status === 400 && /model|not found|not supported/i.test(em))) break;
        throw new Error("Gemini devolvió un error: " + em);
      }
    }
    if (sat) throw new Error("Gemini está saturado en este momento. Probá de nuevo en un rato.");
    if (lim) throw new Error("Se alcanzó el límite de Gemini por ahora. Probá de nuevo en un rato. (" + ult + ")");
    if (red) throw new Error("El servidor no pudo conectarse con Gemini.");
    throw new Error("Ningún modelo de Gemini respondió: " + ult);
  }
}
