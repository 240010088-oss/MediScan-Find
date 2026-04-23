const express = require('express');
const path = require('path');
const axios = require('axios');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const admin = require('firebase-admin');
const fs = require('fs');
const cors = require('cors');

// ═══════════════════════════════════════════════
//  1. INICIALIZAR APP
// ═══════════════════════════════════════════════
const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ dest: 'uploads/' });

// ═══════════════════════════════════════════════
//  2. MIDDLEWARE GLOBAL
// ═══════════════════════════════════════════════

// CORS: permite conexiones desde Android Studio (emulador y dispositivo físico)
app.use(cors({
    origin: '*',          // En producción cambia esto a tu dominio específico
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Ruta principal: sirve el index.html de la carpeta public
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(session({
    secret: process.env.SESSION_SECRET || 'mediscan_secret_key',
    resave: false,
    saveUninitialized: true
}));

// ═══════════════════════════════════════════════
//  3. CONFIGURACIÓN DE SERVICIOS
// ═══════════════════════════════════════════════
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'dovewcneq',
    api_key: process.env.CLOUDINARY_API_KEY || '884442781136663',
    api_secret: process.env.CLOUDINARY_API_SECRET || 'Jomh0fN3PZVDMszNiJNk0Pn68ic'
});

const serviceAccount = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
console.log("🔥 Conectado a Firebase Firestore con éxito");


// ═══════════════════════════════════════════════
//  HELPER: TRADUCCIÓN con Google Translate (gratis, sin key)
// ═══════════════════════════════════════════════
async function traducir(texto) {
    if (!texto || texto.trim() === '') return 'No disponible';

    const textoLimpio = texto
        .replace(/\n+/g, ' ')
        .replace(/\s+/g, ' ')
        .substring(0, 1000)
        .trim();

    try {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=es&dt=t&q=${encodeURIComponent(textoLimpio)}`;
        const res = await axios.get(url, { timeout: 8000 });

        const fragmentos = res.data[0];
        if (!fragmentos || !Array.isArray(fragmentos)) return textoLimpio;

        const traduccion = fragmentos
            .map(f => f[0])
            .filter(Boolean)
            .join(' ');

        return traduccion || textoLimpio;
    } catch (e) {
        console.log('⚠️ Google Translate falló:', e.message);
        return textoLimpio;
    }
}

async function traducirInfoClinica(infoEn) {
    const [uso, dosificacion, advertencias, reacciones] = await Promise.all([
        traducir(infoEn.uso),
        traducir(infoEn.dosificacion),
        traducir(infoEn.advertencias),
        traducir(infoEn.reacciones)
    ]);
    return { uso, dosificacion, advertencias, reacciones };
}


// ═══════════════════════════════════════════════
//  HELPER: RxNav → normalizar nombre del medicamento
// ═══════════════════════════════════════════════
async function obtenerRxCUI(medicamento) {
    try {
        const res = await axios.get(
            `https://rxnav.nlm.nih.gov/REST/rxcui.json?name=${encodeURIComponent(medicamento)}&search=2`,
            { timeout: 6000 }
        );
        const rxcui = res.data?.idGroup?.rxnormId?.[0];
        if (!rxcui) return null;

        const propsRes = await axios.get(
            `https://rxnav.nlm.nih.gov/REST/rxcui/${rxcui}/properties.json`,
            { timeout: 6000 }
        );
        const nombre = propsRes.data?.properties?.name;
        return { rxcui, nombre: nombre || medicamento };
    } catch {
        return null;
    }
}


// ═══════════════════════════════════════════════
//  HELPER: DailyMed → info clínica oficial
// ═══════════════════════════════════════════════
const DAILYMED_HEADERS = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'MediScanAndFind/1.0'
};

async function buscarEnDailyMed(nombreNormalizado) {
    try {
        const searchRes = await axios.get(
            `https://dailymed.nlm.nih.gov/dailymed/services/v2/spls.json?drug_name=${encodeURIComponent(nombreNormalizado)}&pagesize=1`,
            { timeout: 7000, headers: DAILYMED_HEADERS }
        );

        const splData = searchRes.data?.data;
        if (!splData?.length) return null;

        const setid = splData[0].setid;
        if (!setid) return null;

        const detailRes = await axios.get(
            `https://dailymed.nlm.nih.gov/dailymed/services/v2/spls/${setid}.json`,
            { timeout: 7000, headers: DAILYMED_HEADERS }
        );

        const sections = detailRes.data?.data?.spl?.text?.section;
        if (!sections || !Array.isArray(sections)) return null;

        const extraerSeccion = (terminos) => {
            const seccion = sections.find(s =>
                terminos.some(t =>
                    s.code?.code === t ||
                    s.title?.toLowerCase().includes(t)
                )
            );
            if (!seccion) return '';
            const texto = seccion.text || seccion.excerpt || '';
            return typeof texto === 'string'
                ? texto.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
                : '';
        };

        const resultado = {
            uso: extraerSeccion(['34067-9', 'indications', 'indication']),
            dosificacion: extraerSeccion(['34068-7', 'dosage', 'administration']),
            advertencias: extraerSeccion(['34071-1', '43685-7', 'warning', 'warnings']),
            reacciones: extraerSeccion(['34084-4', 'adverse', 'reactions']),
            fuente: 'dailymed'
        };

        if (resultado.uso || resultado.advertencias) return resultado;
        return null;

    } catch (err) {
        console.log('DailyMed error:', err.message);
        return null;
    }
}


// ═══════════════════════════════════════════════
//  HELPER: FDA → fallback
// ═══════════════════════════════════════════════
async function buscarEnFDA(medicamento) {
    const queries = [
        `openfda.brand_name:"${medicamento}"`,
        `openfda.generic_name:"${medicamento}"`,
        `openfda.substance_name:"${medicamento}"`
    ];

    for (const query of queries) {
        try {
            const res = await axios.get(
                `https://api.fda.gov/drug/label.json?search=${encodeURIComponent(query)}&limit=1`,
                { timeout: 6000 }
            );
            if (res.data?.results?.length) {
                const info = res.data.results[0];
                const uso = info.indications_and_usage?.[0] || '';
                const advertencias = info.warnings?.[0] || info.warnings_and_cautions?.[0] || '';
                if (uso || advertencias) {
                    return {
                        uso,
                        dosificacion: info.dosage_and_administration?.[0] || '',
                        advertencias,
                        reacciones: info.adverse_reactions?.[0] || '',
                        fuente: 'fda'
                    };
                }
            }
        } catch { continue; }
    }
    return null;
}


// ═══════════════════════════════════════════════
//  ORQUESTADOR: RxNav → DailyMed → FDA → Traducción
// ═══════════════════════════════════════════════
async function obtenerInfoMedicamento(medicamento) {
    let infoEn = null;
    let nombreBusqueda = medicamento;

    console.log(`🔍 Normalizando "${medicamento}" con RxNav...`);
    const rxData = await obtenerRxCUI(medicamento);
    if (rxData) {
        nombreBusqueda = rxData.nombre;
        console.log(`✅ RxNav → "${nombreBusqueda}" (RxCUI: ${rxData.rxcui})`);
    } else {
        console.log(`⚠️ RxNav no encontró "${medicamento}"`);
    }

    console.log(`🔍 Buscando en DailyMed...`);
    infoEn = await buscarEnDailyMed(nombreBusqueda);

    if (!infoEn) {
        console.log(`🔍 DailyMed sin resultados, intentando FDA...`);
        infoEn = await buscarEnFDA(nombreBusqueda);

        if (!infoEn && nombreBusqueda !== medicamento) {
            console.log(`🔍 FDA con nombre original "${medicamento}"...`);
            infoEn = await buscarEnFDA(medicamento);
        }
    }

    if (infoEn) {
        console.log(`🌐 Traduciendo al español... (fuente: ${infoEn.fuente})`);
        const infoEs = await traducirInfoClinica(infoEn);
        console.log(`✅ Traducción completada`);
        return {
            uso: infoEs.uso || 'No disponible',
            dosificacion: infoEs.dosificacion || 'No disponible',
            advertencias: infoEs.advertencias || 'No disponible',
            reacciones: infoEs.reacciones || 'No disponible'
        };
    }

    console.log(`❌ Sin resultados para "${medicamento}"`);
    return {
        uso: `No se encontró información para "${medicamento}". Prueba con el nombre genérico (ej: "acetaminofén" en vez de "Tempra").`,
        dosificacion: 'Consulta el prospecto del medicamento o a tu farmacéutico.',
        advertencias: 'Siempre consulta a un médico antes de tomar cualquier medicamento.',
        reacciones: 'Información no disponible.'
    };
}


// ═══════════════════════════════════════════════
//  RUTAS DE USUARIO
// ═══════════════════════════════════════════════

app.post('/api/registro', async (req, res) => {
    try {
        const { email, password, nombre } = req.body;
        const snapshot = await db.collection('usuarios').where('email', '==', email).get();
        if (!snapshot.empty) return res.status(400).json({ error: "El email ya está registrado" });
        const hashedPassword = await bcrypt.hash(password, 10);
        await db.collection('usuarios').add({
            nombre, email, password: hashedPassword,
            historialBusquedas: [], recetasGuardadas: []
        });
        res.status(201).json({ message: "Usuario creado con éxito" });
    } catch (error) {
        console.error("Error en registro:", error);
        res.status(500).json({ error: "Error en el servidor" });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const snapshot = await db.collection('usuarios').where('email', '==', email).get();
        if (snapshot.empty) return res.status(401).json({ error: "Usuario no encontrado" });
        const usuarioDoc = snapshot.docs[0];
        const usuarioData = usuarioDoc.data();
        if (await bcrypt.compare(password, usuarioData.password)) {
            req.session.usuarioId = usuarioDoc.id;
            res.json({ message: "Inicio de sesión correcto", nombre: usuarioData.nombre, id: usuarioDoc.id });
        } else {
            res.status(401).json({ error: "Contraseña incorrecta" });
        }
    } catch (error) {
        console.error("Error en login:", error);
        res.status(500).json({ error: "Error en el servidor" });
    }
});

app.get('/api/perfil', async (req, res) => {
    const { usuarioId } = req.query;
    if (!usuarioId || usuarioId === "undefined") return res.status(400).json({ error: "No se proporcionó ID de usuario" });
    try {
        const userDoc = await db.collection('usuarios').doc(usuarioId).get();
        if (!userDoc.exists) return res.status(404).json({ error: "Usuario no encontrado" });
        const userData = userDoc.data();
        const historialSnapshot = await db.collection('historial')
            .where('usuarioId', '==', usuarioId)
            .orderBy('fecha', 'desc').limit(10).get();
        const historial = historialSnapshot.docs.map(doc => doc.data());
        res.json({ nombre: userData.nombre, email: userData.email, historial });
    } catch (error) {
        console.error("Error al cargar perfil:", error);
        res.status(500).json({ error: "Error interno del servidor" });
    }
});


// ═══════════════════════════════════════════════
//  RUTAS DE RECETAS
// ═══════════════════════════════════════════════

app.post('/api/subir-receta', upload.single('imagen'), async (req, res) => {
    const { usuarioId, nombreMedicamento } = req.body;
    try {
        if (!req.file) return res.status(400).send("No se subió ninguna imagen");
        const resultado = await cloudinary.uploader.upload(req.file.path, { folder: 'mediscan_recetas' });

        // Eliminar archivo temporal del disco
        fs.unlink(req.file.path, (err) => {
            if (err) console.error("Error al eliminar archivo temporal:", err.message);
        });

        if (usuarioId) {
            await db.collection('recetas').add({
                usuarioId, nombreMedicamento,
                url: resultado.secure_url,
                public_id: resultado.public_id,
                fecha: new Date()
            });
        }
        res.json({ success: true, url: resultado.secure_url, message: "Receta guardada exitosamente" });
    } catch (error) {
        console.error("Error al subir receta:", error);
        res.status(500).json({ error: "Error al subir a la nube" });
    }
});

app.get('/api/recetas', async (req, res) => {
    const { usuarioId } = req.query;
    if (!usuarioId) return res.status(400).json({ error: "ID de usuario requerido" });
    try {
        const snapshot = await db.collection('recetas')
            .where('usuarioId', '==', usuarioId).orderBy('fecha', 'desc').get();
        res.json(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    } catch (error) {
        console.error("Error al obtener recetas:", error);
        res.status(500).json({ error: "Error al obtener recetas" });
    }
});


// ═══════════════════════════════════════════════
//  RUTA PRINCIPAL: /api/buscar
// ═══════════════════════════════════════════════
app.get('/api/buscar', async (req, res) => {
    const { medicamento, lat, lng, usuarioId } = req.query;
    const latNum = parseFloat(lat);
    const lngNum = parseFloat(lng);
    const viewbox = `${lngNum - 0.1},${latNum + 0.1},${lngNum + 0.1},${latNum - 0.1}`;

    try {
        const osmPromise = axios.get(
            `https://nominatim.openstreetmap.org/search?format=json&q=farmacia&viewbox=${viewbox}&bounded=1&addressdetails=1&limit=10`,
            { headers: { 'User-Agent': 'MediScanAndFind/1.0' }, timeout: 7000 }
        ).catch(() => ({ data: [] }));

        const [infoClinica, osmRes] = await Promise.all([
            obtenerInfoMedicamento(medicamento),
            osmPromise
        ]);

        const farmacias = osmRes.data.map(p => ({
            name: p.display_name.split(',')[0],
            vicinity: p.display_name,
            lat: p.lat,
            lon: p.lon
        }));

        if (usuarioId && usuarioId !== "undefined") {
            db.collection('historial').add({
                usuarioId, medicamento,
                lat: latNum, lng: lngNum,
                fecha: new Date()
            })
            .then(() => console.log("✅ Guardado en historial"))
            .catch(err => console.error("❌ Error historial:", err));
        }

        res.json({ nombre: medicamento.toUpperCase(), ...infoClinica, farmacias });

    } catch (error) {
        console.error("Error en /api/buscar:", error);
        res.status(500).json({ error: "Error al procesar la búsqueda" });
    }
});


// ═══════════════════════════════════════════════
//  ENCENDER SERVIDOR
// ═══════════════════════════════════════════════
// Escucha en 0.0.0.0 para que Android Studio pueda conectarse
// - Emulador usa:         http://10.0.2.2:3000
// - Dispositivo fisico:   http://<tu-IP-local>:3000  (ej: 192.168.1.X)
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor escuchando en http://localhost:${PORT}`);
    console.log(`📱 Android emulador  → http://10.0.2.2:${PORT}`);
    console.log(`📲 Dispositivo fisico → http://<tu-IP-local>:${PORT}`);
});
