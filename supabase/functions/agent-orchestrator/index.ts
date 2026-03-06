import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ============================================================
// BRUNEAU AGENT ORCHESTRATOR
// Single Supabase DB (Bruneau-Protection) — all apps share it
// ============================================================

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// --- Single Supabase client (service_role for full access) ---
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
                systemInstruction: {
                    parts: [{ text: SYSTEM_PROMPT }],
                },
                generationConfig: {
                    temperature: 0.3,
                    topP: 0.8,
                    maxOutputTokens: 2048,
                },
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

RECHERCHE DE CLIENTS :
- search_client cherche d'abord dans la base Supabase locale, puis dans Extrabat si pas assez de résultats
- Chaque client retourné a un champ "source" ("supabase" ou "extrabat")
- Les clients "supabase" ont un UUID valide comme id, utilisable directement pour créer des SAV ou opportunités
- Les clients "extrabat" ont un id au format "extrabat-XXXX" — Ce n'est PAS un UUID valide ! Tu ne peux PAS l'utiliser directement dans client_id pour create_sav_request ou create_opportunity
- Si l'utilisateur choisit un client "extrabat", précise-lui que ce client n'est pas encore dans la base locale et que le SAV/opportunité ne peut pas être lié automatiquement. Propose de créer le SAV avec les infos du client (nom, téléphone, adresse) mais SANS client_id (passe null)
- Quand tu proposes la liste des clients à l'utilisateur via ask_user_selection, indique la source. Exemple : "Pages Jean (Supabase)" ou "Pages Jean (Extrabat)"

STRUCTURE DE LA BASE :
- Table "clients" : clients unifiés (id, nom, prenom, email, telephone, adresse, code_postal, ville, civilite, entreprise, client_type, source, actif)
- Table "sav_requests" : demandes SAV (id, client_id FK→clients, client_name, phone, address, system_type, problem_desc, status[nouvelle/en_cours/terminee/archivee], urgent, priority)
- Table "opportunites" : opportunités commerciales (id, client_id FK→clients, titre, description, statut[nouveau/a-contacter/rdv-pris/devis-envoye/relance/negoce/signe/perdu], suivi_par, montant_estime)
- Table "maintenance_contracts" : contrats de maintenance (id, client_id FK→clients, client_name, system_type, status, address)
- Table "stock_products" : stock (id, name, code_article, depot_quantity, min_quantity, paul_truck_quantity, quentin_truck_quantity)
- Table "devis" : devis (id, client_id FK→clients, devis_number, status, titre_affaire)

Types de systèmes : ssi (détection incendie), type4 (alarme incendie type 4), intrusion (alarme anti-intrusion), video (vidéosurveillance), controle_acces, interphone, portail, autre.`;

// --- Tool definitions ---
const TOOLS = [
    {
        name: "search_client",
        description: "Rechercher un client par nom. Cherche d'abord dans la base locale Supabase, puis dans Extrabat si pas assez de résultats. Retourne les clients correspondants avec leurs coordonnées et la source (supabase ou extrabat).",
        parameters: {
            type: "OBJECT",
            properties: {
                query: {
                    type: "STRING",
                    description: "Le nom (ou partie du nom) du client à rechercher",
                },
            },
            required: ["query"],
        },
    },
    {
        name: "create_sav_request",
        description: "Créer une nouvelle demande SAV. IMPORTANT: appeler ask_user_confirmation d'abord.",
        parameters: {
            type: "OBJECT",
            properties: {
                client_id: { type: "STRING", description: "UUID du client Supabase (obtenu via search_client, source 'supabase'). Null si client Extrabat uniquement." },
                client_name: { type: "STRING", description: "Nom du client" },
                phone: { type: "STRING", description: "Téléphone (optionnel)" },
                address: { type: "STRING", description: "Adresse (optionnel)" },
                system_type: { type: "STRING", description: "Type: ssi, type4, intrusion, video, controle_acces, interphone, portail, autre" },
                problem_desc: { type: "STRING", description: "Description du problème" },
                urgent: { type: "BOOLEAN", description: "Urgent ou non" },
                assigned_user_id: { type: "STRING", description: "UUID de l'utilisateur assigné (obtenu via list_users)" },
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
                client_id: { type: "STRING", description: "UUID du client Supabase (obtenu via search_client, source 'supabase'). Null si client Extrabat uniquement." },
                client_name: { type: "STRING", description: "Nom du client" },
                titre: { type: "STRING", description: "Titre de l'opportunité" },
                description: { type: "STRING", description: "Description" },
                montant_estime: { type: "NUMBER", description: "Montant estimé (optionnel)" },
                suivi_par: { type: "STRING", description: "Personne en charge (défaut: Quentin)" },
            },
            required: ["client_name", "titre", "description"],
        },
    },
    {
        name: "get_sav_stats",
        description: "Statistiques SAV sur une période donnée",
        parameters: {
            type: "OBJECT",
            properties: {
                period: { type: "STRING", description: "today, week, month (défaut: week)" },
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
        description: "Vérifier le stock d'un produit par nom ou code article",
        parameters: {
            type: "OBJECT",
            properties: {
                query: { type: "STRING", description: "Nom ou code article du produit" },
            },
            required: ["query"],
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
    {
        name: "ask_user_confirmation",
        description: "Demander confirmation à l'utilisateur AVANT toute action d'écriture. OBLIGATOIRE avant create_sav_request ou create_opportunity.",
        parameters: {
            type: "OBJECT",
            properties: {
                message: { type: "STRING", description: "Message de confirmation" },
                action_type: { type: "STRING", description: "Type d'action (create_sav, create_opportunity)" },
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

    if (!apiKey || !securityKey) {
        console.warn("Extrabat API credentials not configured, skipping Extrabat search");
        return [];
    }

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

    // Normalize Extrabat client data to match our format
    return clients.map((client: any) => {
        let telephone = "";
        if (client.telephones && Array.isArray(client.telephones) && client.telephones.length > 0) {
            telephone = client.telephones[0].number || client.telephones[0].numero || "";
        }

        let adresse = "";
        let code_postal = "";
        let ville = "";
        if (client.adresses && Array.isArray(client.adresses) && client.adresses.length > 0) {
            const addr = client.adresses[0];
            adresse = addr.description || addr.adresse || addr.rue || "";
            code_postal = addr.codePostal || addr.code_postal || "";
            ville = addr.ville || "";
        }

        return {
            id: `extrabat-${client.id}`,
            extrabat_id: client.id,
            nom: client.nom || "",
            prenom: client.prenom || "",
            email: client.email || "",
            telephone,
            adresse,
            code_postal,
            ville,
            civilite: client.civilite?.libelle || "",
            entreprise: client.raisonSociale || "",
            client_type: client.civilite?.professionnel ? "professionnel" : "particulier",
            actif: true,
            source: "extrabat",
        };
    }).slice(0, 10);
}

// --- Tool execution ---
async function executeTool(toolName: string, args: any): Promise<any> {
    const db = getDB();
    console.log(`Executing tool: ${toolName}`, JSON.stringify(args));

    switch (toolName) {
        case "search_client": {
            // Strip French civility prefixes and clean up the query
            const civilities = /^(m\.|mr\.?|mme\.?|monsieur|madame|mademoiselle|mlle\.?|société|ste\.?|ets\.?)\s+/i;
            const cleanedQuery = args.query.replace(civilities, "").trim();
            // Split into words and search for each meaningful word (length > 1)
            const words = cleanedQuery.split(/\s+/).filter((w: string) => w.length > 1);
            const searchTerms = words.length > 0 ? words : [cleanedQuery];

            // Build OR conditions: search each word against nom, prenom, entreprise
            const orConditions = searchTerms
                .map((term: string) => `nom.ilike.%${term}%,prenom.ilike.%${term}%,entreprise.ilike.%${term}%`)
                .join(",");

            const { data, error } = await db
                .from("clients")
                .select("id, nom, prenom, email, telephone, adresse, code_postal, ville, civilite, entreprise, client_type, actif")
                .or(orConditions)
                .eq("actif", true)
                .order("updated_at", { ascending: false })
                .limit(10);

            if (error) return { error: error.message };

            const supabaseClients = (data || []).map((c: any) => ({ ...c, source: "supabase" }));

            // If Supabase returned few or no results, also search Extrabat
            if (supabaseClients.length < 3) {
                try {
                    const extrabatClients = await searchExtrabat(cleanedQuery);
                    // Deduplicate: exclude Extrabat clients already found in Supabase (by nom match)
                    const supabaseNoms = new Set(supabaseClients.map((c: any) => (c.nom || "").toLowerCase()));
                    const uniqueExtrabat = extrabatClients.filter(
                        (c: any) => !supabaseNoms.has((c.nom || "").toLowerCase())
                    );
                    const combined = [...supabaseClients, ...uniqueExtrabat].slice(0, 15);
                    return { clients: combined, count: combined.length };
                } catch (extrabatError) {
                    console.error("Extrabat search failed (fallback to Supabase only):", extrabatError);
                }
            }

            return { clients: supabaseClients, count: supabaseClients.length };
        }

        case "list_users": {
            const { data, error } = await db
                .from("users")
                .select("id, display_name, email, role")
                .order("display_name");

            if (error) return { error: error.message };
            return { users: data || [], count: (data || []).length };
        }

        case "create_sav_request": {
            // Handle client_id: skip if null, empty, or starts with "extrabat-" (not a valid Supabase UUID)
            const validClientId = args.client_id && !args.client_id.startsWith("extrabat-") ? args.client_id : null;
            const insertData: any = {
                client_name: args.client_name,
                phone: args.phone || null,
                address: args.address || null,
                system_type: args.system_type || "autre",
                problem_desc: args.problem_desc,
                urgent: args.urgent || false,
                status: "nouvelle",
            };
            if (validClientId) {
                insertData.client_id = validClientId;
            }
            if (args.assigned_user_id) {
                insertData.assigned_user_id = args.assigned_user_id;
            }
            const { data, error } = await db
                .from("sav_requests")
                .insert(insertData)
                .select("id, client_name, status, system_type, problem_desc")
                .single();

            if (error) return { error: error.message };
            return { success: true, sav_request: data };
        }

        case "create_opportunity": {
            // Handle client_id: skip if null, empty, or starts with "extrabat-" (not a valid Supabase UUID)
            const validOppClientId = args.client_id && !args.client_id.startsWith("extrabat-") ? args.client_id : null;
            const oppInsertData: any = {
                titre: args.titre,
                description: args.description || "",
                montant_estime: args.montant_estime || null,
                suivi_par: args.suivi_par || "Quentin",
                statut: "nouveau",
            };
            if (validOppClientId) {
                oppInsertData.client_id = validOppClientId;
            }
            const { data, error } = await db
                .from("opportunites")
                .insert(oppInsertData)
                .select("id, titre, statut")
                .single();

            if (error) return { error: error.message };
            return { success: true, opportunity: data };
        }

        case "get_sav_stats": {
            const period = args?.period || "week";
            const dateFilter = new Date();
            if (period === "today") dateFilter.setHours(0, 0, 0, 0);
            else if (period === "week") dateFilter.setDate(dateFilter.getDate() - 7);
            else if (period === "month") dateFilter.setMonth(dateFilter.getMonth() - 1);

            const { data, error } = await db
                .from("sav_requests")
                .select("status")
                .gte("requested_at", dateFilter.toISOString());

            if (error) return { error: error.message };

            const stats: Record<string, number> = { total: 0, nouvelle: 0, en_cours: 0, terminee: 0, archivee: 0 };
            for (const row of data || []) {
                stats.total++;
                const s = row.status || "nouveau";
                if (s in stats) stats[s]++;
            }
            return { period, stats };
        }

        case "get_client_history": {
            const [savRes, oppRes, maintRes] = await Promise.all([
                db.from("sav_requests").select("id, client_name, system_type, problem_desc, status, requested_at").eq("client_id", args.client_id).order("requested_at", { ascending: false }).limit(5),
                db.from("opportunites").select("id, titre, statut, montant_estime, date_creation").eq("client_id", args.client_id).order("date_creation", { ascending: false }).limit(5),
                db.from("maintenance_contracts").select("id, client_name, system_type, status, address").eq("client_id", args.client_id).limit(5),
            ]);

            return {
                sav_requests: savRes.data || [],
                opportunites: oppRes.data || [],
                maintenance_contracts: maintRes.data || [],
            };
        }

        case "check_stock": {
            const { data, error } = await db
                .from("stock_products")
                .select("id, name, code_article, marque, depot_quantity, min_quantity, paul_truck_quantity, quentin_truck_quantity")
                .or(`name.ilike.%${args.query}%,code_article.ilike.%${args.query}%`)
                .limit(10);

            if (error) return { error: error.message };
            return { products: data || [], count: (data || []).length };
        }

        case "ask_user_confirmation": {
            let details = {};
            try { details = JSON.parse(args.details); } catch { details = {}; }
            return {
                _hitl: true,
                type: "confirm",
                message: args.message,
                details,
                pendingAction: args.action_type,
            };
        }

        case "ask_user_selection": {
            let options = [];
            try { options = JSON.parse(args.options); } catch { options = []; }
            return {
                _hitl: true,
                type: "select",
                message: args.message,
                options,
                pendingAction: "select",
            };
        }

        default:
            return { error: `Unknown tool: ${toolName}` };
    }
}

// --- Process Gemini response (with recursive tool call handling) ---
async function processGeminiResponse(
    geminiResult: any,
    messages: any[],
    depth = 0
): Promise<any> {
    if (depth > 5) return { type: "error", message: "Trop d'étapes. Reformulez votre demande." };

    const candidate = geminiResult?.candidates?.[0];
    if (!candidate?.content?.parts) {
        return { type: "error", message: "Réponse inattendue du modèle." };
    }

    // Collect ALL function calls from this response (Gemini can return multiple in parallel)
    const functionCalls = candidate.content.parts.filter((p: any) => p.functionCall);
    const textParts = candidate.content.parts.filter((p: any) => p.text);

    if (functionCalls.length === 0) {
        // No function calls — return text
        const text = textParts.map((p: any) => p.text).join("\n");
        return { type: "text", message: text || "Je n'ai pas compris. Pouvez-vous reformuler ?" };
    }

    // Execute ALL function calls
    const modelParts: any[] = [];
    const responseParts: any[] = [];
    let hitlResult: any = null;

    for (const part of functionCalls) {
        const { name, args } = part.functionCall;
        const result = await executeTool(name, args || {});

        // If HITL needed, save it but still execute remaining non-HITL calls
        if (result?._hitl) {
            delete result._hitl;
            hitlResult = result;
            continue;
        }

        modelParts.push({ functionCall: { name, args: args || {} } });
        responseParts.push({ functionResponse: { name, response: result } });
    }

    // If any call was HITL, return it now (after executing all non-HITL calls)
    if (hitlResult) {
        return hitlResult;
    }

    // Feed ALL results back to Gemini in one turn
    if (modelParts.length > 0) {
        messages.push({ role: "model", parts: modelParts });
        messages.push({ role: "user", parts: responseParts });

        let followUp;
        try {
            followUp = await callGemini(messages, TOOLS);
        } catch (error) {
            console.error("Gemini follow-up failed:", error);
            return { type: "error", message: "Erreur lors du traitement." };
        }

        return processGeminiResponse(followUp, messages, depth + 1);
    }

    return { type: "text", message: "Je n'ai pas compris. Pouvez-vous reformuler ?" };
}

// --- Main conversation handler ---
async function handleConversation(body: any): Promise<any> {
    const { message, conversation = [], actionResponse } = body;

    // Build Gemini conversation
    const geminiMessages: any[] = [];

    for (const msg of conversation) {
        geminiMessages.push({
            role: msg.role === "user" ? "user" : "model",
            parts: [{ text: msg.content }],
        });
    }

    // Add current message if not already in history
    if (message && (!conversation.length || conversation[conversation.length - 1]?.content !== message)) {
        geminiMessages.push({ role: "user", parts: [{ text: message }] });
    }

    // Handle HITL action responses
    if (actionResponse) {
        if (actionResponse.type === "confirm" && actionResponse.confirmed) {
            // Direct execution: use the confirmed details to execute the action
            // without re-calling Gemini (which loses tool call context)
            const details = actionResponse.details || {};
            const pending = (actionResponse.pendingAction || "").toLowerCase();
            console.log("HITL confirm received:", JSON.stringify({ pending, details }));

            const isSav = pending.includes("sav");
            const isOpportunity = pending.includes("opportunit");

            if (isSav && details.client_name) {
                const result = await executeTool("create_sav_request", {
                    client_id: details.client_id || null,
                    client_name: details.client_name || "",
                    phone: details.phone || null,
                    address: details.address || null,
                    system_type: details.system_type || "autre",
                    problem_desc: details.problem_desc || "",
                    urgent: details.urgent || false,
                    assigned_user_id: details.assigned_user_id || null,
                });
                console.log("create_sav_request result:", JSON.stringify(result));
                if (result?.success) {
                    return { type: "success", message: `SAV créé avec succès pour ${details.client_name || "le client"}.` };
                }
                return { type: "error", message: `Erreur lors de la création du SAV : ${result?.error || "erreur inconnue"}` };
            }
            if (isOpportunity && (details.client_name || details.client_id)) {
                const result = await executeTool("create_opportunity", {
                    client_id: details.client_id || null,
                    client_name: details.client_name || "",
                    titre: details.titre || "",
                    description: details.description || "",
                    montant_estime: details.montant_estime || null,
                    suivi_par: details.suivi_par || "Quentin",
                });
                console.log("create_opportunity result:", JSON.stringify(result));
                if (result?.success) {
                    return { type: "success", message: `Opportunité créée avec succès pour ${details.client_name || "le client"}.` };
                }
                return { type: "error", message: `Erreur lors de la création de l'opportunité : ${result?.error || "erreur inconnue"}` };
            }
            // Fallback: re-call Gemini with context (for unknown action types)
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

    // Call Gemini
    let geminiResult;
    try {
        geminiResult = await callGemini(cleanMessages, TOOLS);
    } catch (error) {
        console.error("Gemini call failed:", error);
        return { type: "error", message: "Désolé, je n'ai pas pu traiter votre demande." };
    }

    return processGeminiResponse(geminiResult, cleanMessages);
}

// --- HTTP Handler ---
Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }

    if (req.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
            status: 405,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }

    try {
        const body = await req.json();

        if (!body.message && !body.actionResponse) {
            return new Response(
                JSON.stringify({ type: "error", message: "Aucun message reçu." }),
                { headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        const result = await handleConversation(body);

        return new Response(JSON.stringify(result), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    } catch (error) {
        console.error("Handler error:", error);
        return new Response(
            JSON.stringify({ type: "error", message: `Erreur interne: ${error.message}` }),
            {
                status: 500,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            }
        );
    }
});
