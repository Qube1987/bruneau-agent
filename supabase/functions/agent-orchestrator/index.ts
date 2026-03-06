import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ============================================================
// BRUNEAU AGENT ORCHESTRATOR v2
// Single Supabase DB (Bruneau-Protection) — all apps share it
// ============================================================

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function getDB() {
    return createClient(
        Deno.env.get("SUPABASE_URL") || "",
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
    );
}

// --- Gemini API ---
async function callGemini(messages: any[], tools: any[]) {
    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) throw new Error("GEMINI_API_KEY not configured");

    const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: messages,
                tools: tools.length > 0 ? [{ functionDeclarations: tools }] : undefined,
                systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
                generationConfig: { temperature: 0.3, topP: 0.8, maxOutputTokens: 2048 },
            }),
        }
    );

    if (!response.ok) {
        const errorText = await response.text();
        console.error("Gemini API error:", errorText);
        throw new Error(`Gemini API error: ${response.status}`);
    }

    return await response.json();
}

// --- System Prompt ---
const SYSTEM_PROMPT = `Tu es l'assistant vocal intelligent de Bruneau Protection, une entreprise de sécurité (alarmes, vidéosurveillance, contrôle d'accès, SSI, etc.).

Tu as accès à une base de données unique qui contient toutes les données métier. Tu dois :
1. Comprendre les demandes en langage naturel (souvent dictées vocalement, donc avec de possibles erreurs de transcription)
2. Utiliser les bons outils pour réaliser les actions demandées
3. TOUJOURS demander confirmation AVANT d'écrire des données (créer, modifier, supprimer)
4. Être concis dans tes réponses (elles seront lues à voix haute)

RÈGLES IMPORTANTES :
- Ne fais JAMAIS d'action d'écriture sans confirmation préalable de l'utilisateur via ask_user_confirmation
- Si tu trouves plusieurs clients correspondants, utilise ask_user_selection pour proposer la liste
- Si des informations manquent pour créer un enregistrement, demande-les à l'utilisateur
- Utilise un français naturel et professionnel
- Sois bref : ta réponse sera lue à voix haute
- "centrale" ou "centrale d'alarme" fait référence au système d'intrusion
- Quand on te dit "pile HS" ou "batterie HS", le system_type est souvent "intrusion"
- Quand on te demande de "créer un SAV", c'est une sav_request
- FLUX DE CRÉATION SAV : 1) search_client 2) list_users 3) ask_user_selection avec les utilisateurs formatés en options [{label: display_name, subtitle: role, value: id}] pour demander à qui assigner 4) ask_user_confirmation avec TOUS les détails dont assigned_user_id et assigned_user_name 5) create_sav_request
- FLUX DE CRÉATION OPPORTUNITÉ : 1) search_client (cherche le client mentionné) 2) si plusieurs résultats, ask_user_selection 3) ask_user_confirmation avec tous les détails 4) create_opportunity
- IMPORTANT : Pour TOUTE création (SAV ou opportunité), commence TOUJOURS par search_client avec le nom mentionné. Ne demande JAMAIS "pour quel client ?" si un nom est déjà mentionné dans la demande.
- Ne demande JAMAIS de taper un nom d'utilisateur. Utilise TOUJOURS ask_user_selection avec la liste cliquable.
- Pour search_client, utilise UNIQUEMENT le nom de famille (sans civilité M., Mme, etc.). Exemple : pour "M. Pages", cherche "Pages"
- Table "users" : utilisateurs de l'équipe (id, display_name, email, role[admin/manager/technicien])
- Quand on te demande la liste des SAV, opportunités, etc., utilise les outils list_sav_requests ou list_opportunities
- Quand on te demande "combien de SAV" ou des statistiques, utilise get_sav_stats ou get_dashboard_summary
- Pour modifier le statut d'un SAV ou d'une opportunité, utilise update_sav_status ou update_opportunity_status (toujours avec confirmation)
- Pour les alertes stock ou ruptures, utilise get_stock_alerts
- Pour check_stock, passe la requête telle quelle (ex: "centrales ajax", "détecteurs daitem", "batterie"). La recherche est intelligente et cherche dans le nom du produit, la marque, le fournisseur, les catégories et sous-catégories du stock, et les descriptions du catalogue produits.
- Le stock est organisé en catégories (ex: "Alarme Ajax Jeweller", "Vidéosurveillance") et sous-catégories (ex: "Centrales", "Détecteurs", "Sirènes")

RECHERCHE DE CLIENTS :
- search_client cherche d'abord dans la base Supabase locale, puis dans Extrabat si pas assez de résultats
- Chaque client retourné a un champ "source" ("supabase" ou "extrabat")
- Les clients "supabase" ont un UUID valide comme id, utilisable directement pour créer des SAV ou opportunités
- Les clients "extrabat" ont un id au format "extrabat-XXXX" — Ce n'est PAS un UUID valide ! Tu ne peux PAS l'utiliser directement dans client_id pour create_sav_request ou create_opportunity
- Si l'utilisateur choisit un client "extrabat", précise-lui que ce client n'est pas encore dans la base locale et que le SAV/opportunité ne peut pas être lié automatiquement. Propose de créer le SAV avec les infos du client (nom, téléphone, adresse) mais SANS client_id (passe null)
- Quand tu proposes la liste des clients à l'utilisateur via ask_user_selection, indique la source. Exemple : "Pages Jean (Supabase)" ou "Pages Jean (Extrabat)"

FORMAT DES RÉPONSES POUR LES LISTES :
- Quand tu retournes une liste (SAV, opportunités, etc.), formate-la de manière claire et concise
- Indique le nombre total de résultats
- Pour les SAV : "📋 Client | Problème | Statut | Date"
- Pour les opportunités : "📊 Client | Titre | Statut | Suivi par"
- Limite à 10 éléments max pour la lecture vocale, mentionne s'il y en a plus

STRUCTURE DE LA BASE :
- Table "clients" : clients unifiés (id, nom, prenom, email, telephone, adresse, code_postal, ville, civilite, entreprise, client_type, source, actif)
- Table "sav_requests" : demandes SAV (id, client_id, client_name, phone, address, system_type, problem_desc, status[nouvelle/en_cours/terminee/archivee], urgent, priority, assigned_user_id, requested_at, resolved_at, billing_status)
- Table "opportunites" : opportunités commerciales (id, client_id, titre, description, statut[a-contacter/contacte/recueil-besoin/redaction-devis/devis-transmis/relance-1/relance-2/relance-3], suivi_par, montant_estime, statut_final[gagne/perdu/standby], archive, prioritaire, date_creation)
- Table "maintenance_contracts" : contrats de maintenance (id, client_id, client_name, system_type, system_brand, status[actif/inactif], address, annual_amount, billing_mode, invoice_sent, invoice_paid)
- Table "stock_products" : stock (id, name, code_article, marque, fournisseur, depot_quantity, min_quantity, paul_truck_quantity, quentin_truck_quantity)
- Table "devis" : devis (id, client_id, devis_number, status[brouillon/envoye/accepte/refuse], titre_affaire, totaux)
- Table "call_notes" : notes d'appels (id, client_name, call_subject, notes, is_completed, priority)

Types de systèmes : ssi (détection incendie), type4 (alarme incendie type 4), intrusion (alarme anti-intrusion), video (vidéosurveillance), controle_acces, interphone, portail, autre.`;

// --- Tool definitions ---
const TOOLS = [
    // ===== SEARCH & READ =====
    {
        name: "search_client",
        description: "Rechercher un client par nom. Cherche dans Supabase puis Extrabat si pas assez de résultats.",
        parameters: {
            type: "OBJECT",
            properties: {
                query: { type: "STRING", description: "Le nom (ou partie du nom) du client à rechercher" },
            },
            required: ["query"],
        },
    },
    {
        name: "list_sav_requests",
        description: "Lister les demandes SAV avec filtres optionnels. Utilise cet outil quand on demande la liste des SAV, les SAV en cours, les SAV du jour, etc.",
        parameters: {
            type: "OBJECT",
            properties: {
                status: { type: "STRING", description: "Filtrer par statut : nouvelle, en_cours, terminee, archivee. Laisser vide pour tous." },
                period: { type: "STRING", description: "Période : today (aujourd'hui), week (cette semaine), month (ce mois). Laisser vide pour tous." },
                assigned_user: { type: "STRING", description: "Filtrer par technicien assigné (nom ou partie du nom)" },
                urgent_only: { type: "BOOLEAN", description: "Si true, ne retourne que les SAV urgents" },
                limit: { type: "NUMBER", description: "Nombre max de résultats (défaut: 20)" },
            },
        },
    },
    {
        name: "list_opportunities",
        description: "Lister les opportunités commerciales avec filtres optionnels. Utilise cet outil quand on demande la liste des opportunités, les opportunités en cours, etc.",
        parameters: {
            type: "OBJECT",
            properties: {
                statut: { type: "STRING", description: "Filtrer par statut : a-contacter, contacte, recueil-besoin, redaction-devis, devis-transmis, relance-1, relance-2, relance-3. Laisser vide pour tous." },
                statut_final: { type: "STRING", description: "Filtrer par statut final : gagne, perdu, standby. Laisser vide pour tous." },
                suivi_par: { type: "STRING", description: "Filtrer par responsable (ex: Quentin, Hugo)" },
                period: { type: "STRING", description: "Période : today, week, month. Laisser vide pour tous." },
                prioritaire_only: { type: "BOOLEAN", description: "Si true, ne retourne que les prioritaires" },
                include_archived: { type: "BOOLEAN", description: "Si true, inclut les archivées (défaut: false)" },
                limit: { type: "NUMBER", description: "Nombre max de résultats (défaut: 20)" },
            },
        },
    },
    {
        name: "list_maintenance_contracts",
        description: "Lister les contrats de maintenance avec filtres optionnels.",
        parameters: {
            type: "OBJECT",
            properties: {
                status: { type: "STRING", description: "Filtrer par statut : actif, inactif. Laisser vide pour tous." },
                search: { type: "STRING", description: "Rechercher par nom de client" },
                limit: { type: "NUMBER", description: "Nombre max de résultats (défaut: 20)" },
            },
        },
    },
    {
        name: "list_devis",
        description: "Lister les devis avec filtres optionnels.",
        parameters: {
            type: "OBJECT",
            properties: {
                status: { type: "STRING", description: "Filtrer par statut : brouillon, envoye, accepte, refuse. Laisser vide pour tous." },
                period: { type: "STRING", description: "Période : today, week, month. Laisser vide pour tous." },
                limit: { type: "NUMBER", description: "Nombre max de résultats (défaut: 20)" },
            },
        },
    },
    {
        name: "get_client_history",
        description: "Obtenir l'historique complet d'un client : SAV, opportunités, contrats de maintenance",
        parameters: {
            type: "OBJECT",
            properties: {
                client_id: { type: "STRING", description: "UUID du client" },
            },
            required: ["client_id"],
        },
    },
    {
        name: "check_stock",
        description: "Recherche intelligente de stock. Cherche dans le nom, code article, marque, fournisseur, catégorie, sous-catégorie et description des produits. Passe la requête entière (ex: 'centrales ajax', 'détecteurs daitem', 'batterie yuasa').",
        parameters: {
            type: "OBJECT",
            properties: {
                query: { type: "STRING", description: "Requête de recherche (mots-clés du produit, marque, catégorie, etc.)" },
            },
            required: ["query"],
        },
    },
    {
        name: "get_stock_alerts",
        description: "Obtenir la liste des produits en rupture ou sous le seuil minimum. Utilise cet outil quand on demande les alertes stock, les ruptures, les produits à commander.",
        parameters: {
            type: "OBJECT",
            properties: {},
        },
    },
    {
        name: "get_sav_stats",
        description: "Statistiques SAV détaillées sur une période donnée : nombre par statut, urgents, etc.",
        parameters: {
            type: "OBJECT",
            properties: {
                period: { type: "STRING", description: "today, week, month (défaut: week)" },
            },
        },
    },
    {
        name: "get_dashboard_summary",
        description: "Résumé global de l'activité : SAV en cours, opportunités actives, alertes stock, maintenance. Utilise cet outil quand on demande un résumé, un point global, ou 'comment ça va'.",
        parameters: {
            type: "OBJECT",
            properties: {},
        },
    },
    {
        name: "list_users",
        description: "Lister les utilisateurs de l'équipe (techniciens, managers, admins). Utile pour savoir à qui assigner un SAV.",
        parameters: {
            type: "OBJECT",
            properties: {},
        },
    },

    // ===== CREATE =====
    {
        name: "create_sav_request",
        description: "Créer une nouvelle demande SAV. IMPORTANT: appeler ask_user_confirmation d'abord.",
        parameters: {
            type: "OBJECT",
            properties: {
                client_id: { type: "STRING", description: "UUID du client Supabase. Null si client Extrabat uniquement." },
                client_name: { type: "STRING", description: "Nom du client" },
                phone: { type: "STRING", description: "Téléphone (optionnel)" },
                address: { type: "STRING", description: "Adresse (optionnel)" },
                system_type: { type: "STRING", description: "Type: ssi, type4, intrusion, video, controle_acces, interphone, portail, autre" },
                problem_desc: { type: "STRING", description: "Description du problème" },
                urgent: { type: "BOOLEAN", description: "Urgent ou non" },
                assigned_user_id: { type: "STRING", description: "UUID de l'utilisateur assigné" },
            },
            required: ["client_name", "system_type", "problem_desc"],
        },
    },
    {
        name: "create_opportunity",
        description: "Créer une nouvelle opportunité commerciale. IMPORTANT: appeler search_client puis ask_user_confirmation d'abord.",
        parameters: {
            type: "OBJECT",
            properties: {
                client_id: { type: "STRING", description: "UUID du client Supabase. Null si client Extrabat uniquement." },
                client_name: { type: "STRING", description: "Nom du client" },
                titre: { type: "STRING", description: "Titre de l'opportunité" },
                description: { type: "STRING", description: "Description" },
                montant_estime: { type: "NUMBER", description: "Montant estimé (optionnel)" },
                suivi_par: { type: "STRING", description: "Personne en charge (défaut: Quentin)" },
            },
            required: ["client_name", "titre", "description"],
        },
    },

    // ===== UPDATE =====
    {
        name: "update_sav_status",
        description: "Modifier le statut d'un SAV. IMPORTANT: appeler ask_user_confirmation d'abord.",
        parameters: {
            type: "OBJECT",
            properties: {
                sav_id: { type: "STRING", description: "UUID du SAV à modifier" },
                new_status: { type: "STRING", description: "Nouveau statut : nouvelle, en_cours, terminee, archivee" },
            },
            required: ["sav_id", "new_status"],
        },
    },
    {
        name: "update_opportunity_status",
        description: "Modifier le statut d'une opportunité. IMPORTANT: appeler ask_user_confirmation d'abord.",
        parameters: {
            type: "OBJECT",
            properties: {
                opportunity_id: { type: "STRING", description: "UUID de l'opportunité à modifier" },
                new_statut: { type: "STRING", description: "Nouveau statut : a-contacter, contacte, recueil-besoin, redaction-devis, devis-transmis, relance-1, relance-2, relance-3" },
                statut_final: { type: "STRING", description: "Statut final (optionnel) : gagne, perdu, standby" },
            },
            required: ["opportunity_id"],
        },
    },

    // ===== HITL =====
    {
        name: "ask_user_confirmation",
        description: "Demander confirmation à l'utilisateur AVANT toute action d'écriture. OBLIGATOIRE avant create/update.",
        parameters: {
            type: "OBJECT",
            properties: {
                message: { type: "STRING", description: "Message de confirmation" },
                action_type: { type: "STRING", description: "Type d'action (create_sav, create_opportunity, update_sav, update_opportunity)" },
                details: { type: "STRING", description: "JSON string des détails à confirmer" },
            },
            required: ["message", "action_type", "details"],
        },
    },
    {
        name: "ask_user_selection",
        description: "Demander à l'utilisateur de choisir parmi plusieurs options",
        parameters: {
            type: "OBJECT",
            properties: {
                message: { type: "STRING", description: "Message à afficher" },
                options: { type: "STRING", description: "JSON array des options [{label, subtitle, value}]" },
            },
            required: ["message", "options"],
        },
    },
];

// --- Extrabat API search helper ---
async function searchExtrabat(query: string): Promise<any[]> {
    const apiKey = Deno.env.get("EXTRABAT_API_KEY");
    const securityKey = Deno.env.get("EXTRABAT_SECURITY");
    if (!apiKey || !securityKey) return [];

    const url = `https://api.extrabat.com/v2/clients?q=${encodeURIComponent(query)}&include=telephone,adresse`;
    console.log("Searching Extrabat:", url);

    const response = await fetch(url, {
        method: "GET",
        headers: {
            "Content-Type": "application/json",
            "X-EXTRABAT-API-KEY": apiKey,
            "X-EXTRABAT-SECURITY": securityKey,
        },
    });

    if (!response.ok) {
        console.error("Extrabat API error:", response.status, await response.text());
        return [];
    }

    const data = await response.json();
    const clients = Array.isArray(data) ? data : (data.data || data.clients || []);

    return clients.map((client: any) => {
        let telephone = "";
        if (client.telephones?.length > 0) {
            telephone = client.telephones[0].number || client.telephones[0].numero || "";
        }
        let adresse = "", code_postal = "", ville = "";
        if (client.adresses?.length > 0) {
            const addr = client.adresses[0];
            adresse = addr.description || addr.adresse || addr.rue || "";
            code_postal = addr.codePostal || addr.code_postal || "";
            ville = addr.ville || "";
        }
        return {
            id: `extrabat-${client.id}`, extrabat_id: client.id,
            nom: client.nom || "", prenom: client.prenom || "",
            email: client.email || "", telephone, adresse, code_postal, ville,
            civilite: client.civilite?.libelle || "",
            entreprise: client.raisonSociale || "",
            client_type: client.civilite?.professionnel ? "professionnel" : "particulier",
            actif: true, source: "extrabat",
        };
    }).slice(0, 10);
}

// --- Date helper ---
function getDateFilter(period?: string): Date | null {
    if (!period) return null;
    const now = new Date();
    if (period === "today") { now.setHours(0, 0, 0, 0); return now; }
    if (period === "week") { now.setDate(now.getDate() - 7); return now; }
    if (period === "month") { now.setMonth(now.getMonth() - 1); return now; }
    return null;
}

// --- Tool execution ---
async function executeTool(toolName: string, args: any): Promise<any> {
    const db = getDB();
    console.log(`Executing tool: ${toolName}`, JSON.stringify(args));

    switch (toolName) {

        // ===== SEARCH CLIENT =====
        case "search_client": {
            const civilities = /^(m\.|mr\.?|mme\.?|monsieur|madame|mademoiselle|mlle\.?|société|ste\.?|ets\.?)\s+/i;
            const cleanedQuery = args.query.replace(civilities, "").trim();
            const words = cleanedQuery.split(/\s+/).filter((w: string) => w.length > 1);
            const searchTerms = words.length > 0 ? words : [cleanedQuery];
            const orConditions = searchTerms
                .map((term: string) => `nom.ilike.%${term}%,prenom.ilike.%${term}%,entreprise.ilike.%${term}%`)
                .join(",");

            const { data, error } = await db.from("clients")
                .select("id, nom, prenom, email, telephone, adresse, code_postal, ville, civilite, entreprise, client_type, actif")
                .or(orConditions).eq("actif", true)
                .order("updated_at", { ascending: false }).limit(10);

            if (error) return { error: error.message };
            const supabaseClients = (data || []).map((c: any) => ({ ...c, source: "supabase" }));

            if (supabaseClients.length < 3) {
                try {
                    const extrabatClients = await searchExtrabat(cleanedQuery);
                    const supabaseNoms = new Set(supabaseClients.map((c: any) => (c.nom || "").toLowerCase()));
                    const uniqueExtrabat = extrabatClients.filter((c: any) => !supabaseNoms.has((c.nom || "").toLowerCase()));
                    const combined = [...supabaseClients, ...uniqueExtrabat].slice(0, 15);
                    return { clients: combined, count: combined.length };
                } catch (e) { console.error("Extrabat search failed:", e); }
            }
            return { clients: supabaseClients, count: supabaseClients.length };
        }

        // ===== LIST SAV REQUESTS =====
        case "list_sav_requests": {
            let query = db.from("sav_requests")
                .select("id, client_name, phone, system_type, problem_desc, status, urgent, priority, requested_at, resolved_at, assigned_user_id")
                .order("requested_at", { ascending: false })
                .limit(args.limit || 20);

            if (args.status) query = query.eq("status", args.status);
            if (args.urgent_only) query = query.eq("urgent", true);

            const dateFilter = getDateFilter(args.period);
            if (dateFilter) query = query.gte("requested_at", dateFilter.toISOString());

            const { data, error } = await query;
            if (error) return { error: error.message };

            let results = data || [];

            // If filtering by assigned_user name, we need to resolve user names
            if (args.assigned_user && results.length > 0) {
                const { data: users } = await db.from("users").select("id, display_name");
                const matchingUserIds = (users || [])
                    .filter((u: any) => u.display_name?.toLowerCase().includes(args.assigned_user.toLowerCase()))
                    .map((u: any) => u.id);
                results = results.filter((r: any) => matchingUserIds.includes(r.assigned_user_id));
            }

            return { sav_requests: results, count: results.length, filters_applied: { status: args.status, period: args.period, urgent: args.urgent_only, user: args.assigned_user } };
        }

        // ===== LIST OPPORTUNITIES =====
        case "list_opportunities": {
            let query = db.from("opportunites")
                .select("id, titre, description, statut, suivi_par, montant_estime, statut_final, archive, prioritaire, date_creation, client_id, clients:client_id(nom, prenom)")
                .order("date_creation", { ascending: false })
                .limit(args.limit || 20);

            if (args.statut) query = query.eq("statut", args.statut);
            if (args.statut_final) query = query.eq("statut_final", args.statut_final);
            if (args.suivi_par) query = query.ilike("suivi_par", `%${args.suivi_par}%`);
            if (args.prioritaire_only) query = query.eq("prioritaire", true);
            if (!args.include_archived) query = query.or("archive.is.null,archive.eq.false");

            const dateFilter = getDateFilter(args.period);
            if (dateFilter) query = query.gte("date_creation", dateFilter.toISOString());

            const { data, error } = await query;
            if (error) return { error: error.message };

            const results = (data || []).map((opp: any) => ({
                ...opp,
                client_name: opp.clients ? `${opp.clients.nom || ""} ${opp.clients.prenom || ""}`.trim() : "Inconnu",
            }));

            return { opportunites: results, count: results.length, filters_applied: { statut: args.statut, suivi_par: args.suivi_par, period: args.period } };
        }

        // ===== LIST MAINTENANCE CONTRACTS =====
        case "list_maintenance_contracts": {
            let query = db.from("maintenance_contracts")
                .select("id, client_name, system_type, system_brand, status, address, city_derived, annual_amount, billing_mode, invoice_sent, invoice_paid")
                .order("created_at", { ascending: false })
                .limit(args.limit || 20);

            if (args.status) query = query.eq("status", args.status);
            if (args.search) query = query.ilike("client_name", `%${args.search}%`);

            const { data, error } = await query;
            if (error) return { error: error.message };
            return { contracts: data || [], count: (data || []).length };
        }

        // ===== LIST DEVIS =====
        case "list_devis": {
            let query = db.from("devis")
                .select("id, devis_number, titre_affaire, status, totaux, created_at, client_id, clients:client_id(nom, prenom)")
                .order("created_at", { ascending: false })
                .limit(args.limit || 20);

            if (args.status) query = query.eq("status", args.status);

            const dateFilter = getDateFilter(args.period);
            if (dateFilter) query = query.gte("created_at", dateFilter.toISOString());

            const { data, error } = await query;
            if (error) return { error: error.message };

            const results = (data || []).map((d: any) => ({
                ...d,
                client_name: d.clients ? `${d.clients.nom || ""} ${d.clients.prenom || ""}`.trim() : "Inconnu",
                montant_ttc: d.totaux?.totalTTC || d.totaux?.total_ttc || null,
            }));

            return { devis: results, count: results.length };
        }

        // ===== GET CLIENT HISTORY =====
        case "get_client_history": {
            const [savRes, oppRes, maintRes] = await Promise.all([
                db.from("sav_requests").select("id, client_name, system_type, problem_desc, status, urgent, requested_at").eq("client_id", args.client_id).order("requested_at", { ascending: false }).limit(10),
                db.from("opportunites").select("id, titre, statut, montant_estime, suivi_par, date_creation, statut_final").eq("client_id", args.client_id).order("date_creation", { ascending: false }).limit(10),
                db.from("maintenance_contracts").select("id, client_name, system_type, status, address, annual_amount").eq("client_id", args.client_id).limit(10),
            ]);
            return {
                sav_requests: savRes.data || [], sav_count: (savRes.data || []).length,
                opportunites: oppRes.data || [], opp_count: (oppRes.data || []).length,
                maintenance_contracts: maintRes.data || [], maint_count: (maintRes.data || []).length,
            };
        }

        // ===== CHECK STOCK (smart multi-strategy search) =====
        case "check_stock": {
            const searchTerms = args.query.split(/\s+/).filter((w: string) => w.length > 1);
            const allIdsFound = new Set<string>();
            const allResults: any[] = [];

            // Strategy 1: Direct search on stock_products fields (name, code_article, marque, fournisseur)
            const directOr = searchTerms.flatMap((term: string) => [
                `name.ilike.%${term}%`, `code_article.ilike.%${term}%`,
                `marque.ilike.%${term}%`, `fournisseur.ilike.%${term}%`,
            ]).join(",");

            const { data: directData } = await db.from("stock_products")
                .select("id, name, code_article, marque, fournisseur, depot_quantity, min_quantity, paul_truck_quantity, quentin_truck_quantity, subcategory_id")
                .or(directOr).limit(20);

            for (const p of directData || []) { allIdsFound.add(p.id); allResults.push(p); }

            // Strategy 2: Search via subcategories and categories
            const subcatOr = searchTerms.map((t: string) => `name.ilike.%${t}%`).join(",");
            const { data: subcatMatches } = await db.from("stock_subcategories").select("id").or(subcatOr);
            const catOr = searchTerms.map((t: string) => `name.ilike.%${t}%`).join(",");
            const { data: catMatches } = await db.from("stock_categories").select("id, stock_subcategories(id)").or(catOr);

            const matchSubcatIds = new Set<string>([
                ...(subcatMatches || []).map((s: any) => s.id),
                ...(catMatches || []).flatMap((c: any) => (c.stock_subcategories || []).map((s: any) => s.id)),
            ]);

            if (matchSubcatIds.size > 0) {
                const { data: subcatProducts } = await db.from("stock_products")
                    .select("id, name, code_article, marque, fournisseur, depot_quantity, min_quantity, paul_truck_quantity, quentin_truck_quantity, subcategory_id")
                    .in("subcategory_id", [...matchSubcatIds]).limit(30);
                for (const p of subcatProducts || []) {
                    if (!allIdsFound.has(p.id)) { allIdsFound.add(p.id); allResults.push(p); }
                }
            }

            // Strategy 3: Search via linked products table (description, category)
            const productOr = searchTerms.flatMap((t: string) => [
                `name.ilike.%${t}%`, `description_short.ilike.%${t}%`, `category.ilike.%${t}%`,
            ]).join(",");
            const { data: productMatches } = await db.from("products").select("id").or(productOr).limit(20);
            const matchProductIds = (productMatches || []).map((p: any) => p.id);

            if (matchProductIds.length > 0) {
                const { data: linkedProducts } = await db.from("stock_products")
                    .select("id, name, code_article, marque, fournisseur, depot_quantity, min_quantity, paul_truck_quantity, quentin_truck_quantity, subcategory_id")
                    .in("product_id", matchProductIds).limit(20);
                for (const p of linkedProducts || []) {
                    if (!allIdsFound.has(p.id)) { allIdsFound.add(p.id); allResults.push(p); }
                }
            }

            // Enrich with subcategory/category names
            const uniqueSubcatIds = [...new Set(allResults.map((r: any) => r.subcategory_id).filter(Boolean))];
            let subcatMap: Record<string, { subcategory: string; category: string }> = {};
            if (uniqueSubcatIds.length > 0) {
                const { data: subcats } = await db.from("stock_subcategories")
                    .select("id, name, stock_categories(name)").in("id", uniqueSubcatIds);
                for (const sc of subcats || []) {
                    subcatMap[sc.id] = { subcategory: sc.name, category: sc.stock_categories?.name || "" };
                }
            }

            // Score results: products matching MORE search terms rank higher
            const scored = allResults.map((p: any) => {
                const info = subcatMap[p.subcategory_id] || { subcategory: "", category: "" };
                const searchable = `${p.name} ${p.marque} ${p.fournisseur} ${p.code_article} ${info.subcategory} ${info.category}`.toLowerCase();
                const matchCount = searchTerms.filter((t: string) => searchable.includes(t.toLowerCase())).length;
                const total = (p.depot_quantity || 0) + (p.paul_truck_quantity || 0) + (p.quentin_truck_quantity || 0);
                return {
                    id: p.id, name: p.name, code_article: p.code_article,
                    marque: p.marque, fournisseur: p.fournisseur,
                    category: info.category, subcategory: info.subcategory,
                    depot_quantity: p.depot_quantity || 0,
                    paul_truck_quantity: p.paul_truck_quantity || 0,
                    quentin_truck_quantity: p.quentin_truck_quantity || 0,
                    total_quantity: total, min_quantity: p.min_quantity || 0,
                    is_low: total < (p.min_quantity || 0),
                    _score: matchCount,
                };
            });

            // Sort by score (most matching terms first), then filter top results
            scored.sort((a: any, b: any) => b._score - a._score);
            const topResults = scored.filter((r: any) => r._score === searchTerms.length).length > 0
                ? scored.filter((r: any) => r._score === searchTerms.length).slice(0, 15)
                : scored.slice(0, 15);

            return { products: topResults, count: topResults.length, search_terms: searchTerms };
        }

        // ===== GET STOCK ALERTS =====
        case "get_stock_alerts": {
            const { data, error } = await db.from("stock_products")
                .select("id, name, code_article, marque, fournisseur, depot_quantity, min_quantity, paul_truck_quantity, quentin_truck_quantity")
                .gt("min_quantity", 0);
            if (error) return { error: error.message };

            const alerts = (data || []).filter((p: any) => {
                const total = (p.depot_quantity || 0) + (p.paul_truck_quantity || 0) + (p.quentin_truck_quantity || 0);
                return total < (p.min_quantity || 0);
            }).map((p: any) => ({
                ...p,
                total_quantity: (p.depot_quantity || 0) + (p.paul_truck_quantity || 0) + (p.quentin_truck_quantity || 0),
                deficit: (p.min_quantity || 0) - ((p.depot_quantity || 0) + (p.paul_truck_quantity || 0) + (p.quentin_truck_quantity || 0)),
            }));
            return { alerts, count: alerts.length, message: alerts.length === 0 ? "Aucune alerte stock" : `${alerts.length} produit(s) sous le seuil minimum` };
        }

        // ===== GET SAV STATS =====
        case "get_sav_stats": {
            const period = args?.period || "week";
            const dateFilter = getDateFilter(period) || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

            const { data, error } = await db.from("sav_requests")
                .select("status, urgent").gte("requested_at", dateFilter.toISOString());
            if (error) return { error: error.message };

            const stats = { total: 0, nouvelle: 0, en_cours: 0, terminee: 0, archivee: 0, urgents: 0 };
            for (const row of data || []) {
                stats.total++;
                const s = row.status || "nouvelle";
                if (s in stats) (stats as any)[s]++;
                if (row.urgent) stats.urgents++;
            }
            return { period, stats };
        }

        // ===== GET DASHBOARD SUMMARY =====
        case "get_dashboard_summary": {
            const [savRes, oppRes, stockRes, maintRes] = await Promise.all([
                db.from("sav_requests").select("status, urgent").in("status", ["nouvelle", "en_cours"]),
                db.from("opportunites").select("statut, statut_final, prioritaire, archive").or("archive.is.null,archive.eq.false"),
                db.from("stock_products").select("depot_quantity, min_quantity, paul_truck_quantity, quentin_truck_quantity").gt("min_quantity", 0),
                db.from("maintenance_contracts").select("status").eq("status", "actif"),
            ]);

            // SAV stats
            const savData = savRes.data || [];
            const savStats = { nouvelles: 0, en_cours: 0, urgents: 0 };
            for (const s of savData) {
                if (s.status === "nouvelle") savStats.nouvelles++;
                if (s.status === "en_cours") savStats.en_cours++;
                if (s.urgent) savStats.urgents++;
            }

            // Opp stats
            const oppData = oppRes.data || [];
            const oppStats: Record<string, number> = { total_actives: 0, prioritaires: 0, gagne: 0, perdu: 0 };
            for (const o of oppData) {
                if (!o.statut_final) oppStats.total_actives++;
                if (o.prioritaire) oppStats.prioritaires++;
                if (o.statut_final === "gagne") oppStats.gagne++;
                if (o.statut_final === "perdu") oppStats.perdu++;
            }

            // Stock alerts
            const stockData = stockRes.data || [];
            let stockAlerts = 0;
            for (const p of stockData) {
                const total = (p.depot_quantity || 0) + (p.paul_truck_quantity || 0) + (p.quentin_truck_quantity || 0);
                if (total < (p.min_quantity || 0)) stockAlerts++;
            }

            return {
                sav: savStats,
                opportunites: oppStats,
                stock_alerts: stockAlerts,
                maintenance_active: (maintRes.data || []).length,
            };
        }

        // ===== LIST USERS =====
        case "list_users": {
            const { data, error } = await db.from("users").select("id, display_name, email, role").order("display_name");
            if (error) return { error: error.message };
            return { users: data || [], count: (data || []).length };
        }

        // ===== CREATE SAV =====
        case "create_sav_request": {
            const validClientId = args.client_id && !args.client_id.startsWith("extrabat-") ? args.client_id : null;
            const insertData: any = {
                client_name: args.client_name,
                phone: args.phone || null, address: args.address || null,
                system_type: args.system_type || "autre",
                problem_desc: args.problem_desc,
                urgent: args.urgent || false, status: "nouvelle",
            };
            if (validClientId) insertData.client_id = validClientId;
            if (args.assigned_user_id) insertData.assigned_user_id = args.assigned_user_id;

            const { data, error } = await db.from("sav_requests").insert(insertData)
                .select("id, client_name, status, system_type, problem_desc").single();
            if (error) return { error: error.message };
            return { success: true, sav_request: data };
        }

        // ===== CREATE OPPORTUNITY =====
        case "create_opportunity": {
            const validOppClientId = args.client_id && !args.client_id.startsWith("extrabat-") ? args.client_id : null;
            const oppInsertData: any = {
                titre: args.titre, description: args.description || "",
                montant_estime: args.montant_estime || null,
                suivi_par: args.suivi_par || "Quentin", statut: "a-contacter",
            };
            if (validOppClientId) oppInsertData.client_id = validOppClientId;

            const { data, error } = await db.from("opportunites").insert(oppInsertData)
                .select("id, titre, statut").single();
            if (error) return { error: error.message };
            return { success: true, opportunity: data };
        }

        // ===== UPDATE SAV STATUS =====
        case "update_sav_status": {
            const updateData: any = { status: args.new_status };
            if (args.new_status === "terminee") updateData.resolved_at = new Date().toISOString();
            if (args.new_status === "archivee") updateData.archived_at = new Date().toISOString();

            const { data, error } = await db.from("sav_requests").update(updateData)
                .eq("id", args.sav_id)
                .select("id, client_name, status").single();
            if (error) return { error: error.message };
            return { success: true, sav_request: data };
        }

        // ===== UPDATE OPPORTUNITY STATUS =====
        case "update_opportunity_status": {
            const oppUpdate: any = { date_modification: new Date().toISOString() };
            if (args.new_statut) oppUpdate.statut = args.new_statut;
            if (args.statut_final) {
                oppUpdate.statut_final = args.statut_final;
                oppUpdate.date_cloture = new Date().toISOString();
            }

            const { data, error } = await db.from("opportunites").update(oppUpdate)
                .eq("id", args.opportunity_id)
                .select("id, titre, statut, statut_final").single();
            if (error) return { error: error.message };
            return { success: true, opportunity: data };
        }

        // ===== HITL =====
        case "ask_user_confirmation": {
            let details = {};
            try { details = JSON.parse(args.details); } catch { details = {}; }
            return { _hitl: true, type: "confirm", message: args.message, details, pendingAction: args.action_type };
        }

        case "ask_user_selection": {
            let options = [];
            try { options = JSON.parse(args.options); } catch { options = []; }
            return { _hitl: true, type: "select", message: args.message, options, pendingAction: "select" };
        }

        default:
            return { error: `Unknown tool: ${toolName}` };
    }
}

// --- Process Gemini response ---
async function processGeminiResponse(geminiResult: any, messages: any[], depth = 0): Promise<any> {
    if (depth > 5) return { type: "error", message: "Trop d'étapes. Reformulez votre demande." };

    const candidate = geminiResult?.candidates?.[0];
    if (!candidate?.content?.parts) return { type: "error", message: "Réponse inattendue du modèle." };

    const functionCalls = candidate.content.parts.filter((p: any) => p.functionCall);
    const textParts = candidate.content.parts.filter((p: any) => p.text);

    if (functionCalls.length === 0) {
        const text = textParts.map((p: any) => p.text).join("\n");
        return { type: "text", message: text || "Je n'ai pas compris. Pouvez-vous reformuler ?" };
    }

    const modelParts: any[] = [];
    const responseParts: any[] = [];
    let hitlResult: any = null;

    for (const part of functionCalls) {
        const { name, args } = part.functionCall;
        const result = await executeTool(name, args || {});
        if (result?._hitl) { delete result._hitl; hitlResult = result; continue; }
        modelParts.push({ functionCall: { name, args: args || {} } });
        responseParts.push({ functionResponse: { name, response: result } });
    }

    if (hitlResult) return hitlResult;

    if (modelParts.length > 0) {
        messages.push({ role: "model", parts: modelParts });
        messages.push({ role: "user", parts: responseParts });
        try {
            const followUp = await callGemini(messages, TOOLS);
            return processGeminiResponse(followUp, messages, depth + 1);
        } catch (error) {
            console.error("Gemini follow-up failed:", error);
            return { type: "error", message: "Erreur lors du traitement." };
        }
    }

    return { type: "text", message: "Je n'ai pas compris. Pouvez-vous reformuler ?" };
}

// --- Main conversation handler ---
async function handleConversation(body: any): Promise<any> {
    const { message, conversation = [], actionResponse } = body;
    const geminiMessages: any[] = [];

    for (const msg of conversation) {
        geminiMessages.push({ role: msg.role === "user" ? "user" : "model", parts: [{ text: msg.content }] });
    }
    if (message && (!conversation.length || conversation[conversation.length - 1]?.content !== message)) {
        geminiMessages.push({ role: "user", parts: [{ text: message }] });
    }

    // Handle HITL action responses
    if (actionResponse) {
        if (actionResponse.type === "confirm" && actionResponse.confirmed) {
            const details = actionResponse.details || {};
            const pending = (actionResponse.pendingAction || "").toLowerCase();
            console.log("HITL confirm received:", JSON.stringify({ pending, details }));

            // Direct SAV creation
            if (pending.includes("sav") && !pending.includes("update") && details.client_name) {
                const result = await executeTool("create_sav_request", {
                    client_id: details.client_id || null, client_name: details.client_name || "",
                    phone: details.phone || null, address: details.address || null,
                    system_type: details.system_type || "autre", problem_desc: details.problem_desc || "",
                    urgent: details.urgent || false, assigned_user_id: details.assigned_user_id || null,
                });
                if (result?.success) return { type: "success", message: `SAV créé avec succès pour ${details.client_name}.` };
                return { type: "error", message: `Erreur création SAV : ${result?.error || "inconnue"}` };
            }

            // Direct opportunity creation
            if (pending.includes("opportunit") && !pending.includes("update") && (details.client_name || details.client_id)) {
                const result = await executeTool("create_opportunity", {
                    client_id: details.client_id || null, client_name: details.client_name || "",
                    titre: details.titre || "", description: details.description || "",
                    montant_estime: details.montant_estime || null, suivi_par: details.suivi_par || "Quentin",
                });
                if (result?.success) return { type: "success", message: `Opportunité créée avec succès pour ${details.client_name || "le client"}.` };
                return { type: "error", message: `Erreur création opportunité : ${result?.error || "inconnue"}` };
            }

            // Direct SAV status update
            if (pending.includes("update") && pending.includes("sav") && details.sav_id) {
                const result = await executeTool("update_sav_status", {
                    sav_id: details.sav_id, new_status: details.new_status,
                });
                if (result?.success) return { type: "success", message: `Statut SAV modifié en "${details.new_status}".` };
                return { type: "error", message: `Erreur modification SAV : ${result?.error || "inconnue"}` };
            }

            // Direct opportunity status update
            if (pending.includes("update") && pending.includes("opportunit") && details.opportunity_id) {
                const result = await executeTool("update_opportunity_status", {
                    opportunity_id: details.opportunity_id, new_statut: details.new_statut, statut_final: details.statut_final,
                });
                if (result?.success) return { type: "success", message: `Statut opportunité modifié.` };
                return { type: "error", message: `Erreur modification opportunité : ${result?.error || "inconnue"}` };
            }

            // Fallback
            console.log("HITL confirm fallback — no direct execution match");
            geminiMessages.push({
                role: "user",
                parts: [{ text: `L'utilisateur a confirmé. Exécute l'action maintenant. Détails : ${JSON.stringify(details)}` }],
            });
        } else if (actionResponse.type === "confirm" && !actionResponse.confirmed) {
            return { type: "text", message: "D'accord, action annulée. Que puis-je faire d'autre ?" };
        } else if (actionResponse.type === "select") {
            geminiMessages.push({
                role: "user",
                parts: [{ text: `L'utilisateur a choisi : ${actionResponse.selectedLabel}. Valeur : ${JSON.stringify(actionResponse.selectedValue)}. Continue avec ce choix.` }],
            });
        }
    }

    // Clean consecutive same-role messages
    const cleanMessages: any[] = [];
    let lastRole = "";
    for (const msg of geminiMessages) {
        if (msg.role === lastRole) {
            cleanMessages[cleanMessages.length - 1].parts[0].text += "\n" + msg.parts[0].text;
        } else {
            cleanMessages.push(msg);
            lastRole = msg.role;
        }
    }

    try {
        const geminiResult = await callGemini(cleanMessages, TOOLS);
        return processGeminiResponse(geminiResult, cleanMessages);
    } catch (error) {
        console.error("Gemini call failed:", error);
        return { type: "error", message: "Désolé, je n'ai pas pu traiter votre demande." };
    }
}

// --- HTTP Handler ---
Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
            status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }

    try {
        const body = await req.json();
        if (!body.message && !body.actionResponse) {
            return new Response(JSON.stringify({ type: "error", message: "Aucun message reçu." }),
                { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        const result = await handleConversation(body);
        return new Response(JSON.stringify(result), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    } catch (error: any) {
        console.error("Handler error:", error);
        return new Response(
            JSON.stringify({ type: "error", message: `Erreur interne: ${error.message}` }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }
});
