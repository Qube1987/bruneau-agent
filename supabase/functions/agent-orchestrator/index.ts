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

STRUCTURE DE LA BASE :
- Table "clients" : clients unifiés (id, nom, prenom, email, telephone, adresse, code_postal, ville, civilite, entreprise, client_type, source, actif)
- Table "sav_requests" : demandes SAV (id, client_id FK→clients, client_name, phone, address, system_type, problem_desc, status[nouveau/en_cours/termine/archive], urgent, priority)
- Table "opportunites" : opportunités commerciales (id, client_id FK→clients, titre, description, statut[nouveau/a-contacter/rdv-pris/devis-envoye/relance/negoce/signe/perdu], suivi_par, montant_estime)
- Table "maintenance_contracts" : contrats de maintenance (id, client_id FK→clients, client_name, system_type, status, address)
- Table "stock_products" : stock (id, name, code_article, depot_quantity, min_quantity, paul_truck_quantity, quentin_truck_quantity)
- Table "devis" : devis (id, client_id FK→clients, devis_number, status, titre_affaire)

Types de systèmes : ssi (détection incendie), type4 (alarme incendie type 4), intrusion (alarme anti-intrusion), video (vidéosurveillance), controle_acces, interphone, portail, autre.`;

// --- Tool definitions ---
const TOOLS = [
    {
        name: "search_client",
        description: "Rechercher un client par nom dans la base unifiée. Retourne les clients correspondants avec leurs coordonnées.",
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
                client_id: { type: "STRING", description: "UUID du client (obtenu via search_client)" },
                client_name: { type: "STRING", description: "Nom du client" },
                phone: { type: "STRING", description: "Téléphone (optionnel)" },
                address: { type: "STRING", description: "Adresse (optionnel)" },
                system_type: { type: "STRING", description: "Type: ssi, type4, intrusion, video, controle_acces, interphone, portail, autre" },
                problem_desc: { type: "STRING", description: "Description du problème" },
                urgent: { type: "BOOLEAN", description: "Urgent ou non" },
            },
            required: ["client_id", "client_name", "system_type", "problem_desc"],
        },
    },
    {
        name: "create_opportunity",
        description: "Créer une nouvelle opportunité commerciale. IMPORTANT: appeler ask_user_confirmation d'abord.",
        parameters: {
            type: "OBJECT",
            properties: {
                client_id: { type: "STRING", description: "UUID du client" },
                titre: { type: "STRING", description: "Titre de l'opportunité" },
                description: { type: "STRING", description: "Description" },
                montant_estime: { type: "NUMBER", description: "Montant estimé (optionnel)" },
                suivi_par: { type: "STRING", description: "Personne en charge (défaut: Quentin)" },
            },
            required: ["client_id", "titre", "description"],
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

// --- Tool execution ---
async function executeTool(toolName: string, args: any): Promise<any> {
    const db = getDB();
    console.log(`Executing tool: ${toolName}`, JSON.stringify(args));

    switch (toolName) {
        case "search_client": {
            const { data, error } = await db
                .from("clients")
                .select("id, nom, prenom, email, telephone, adresse, code_postal, ville, civilite, entreprise, client_type, actif")
                .or(`nom.ilike.%${args.query}%,prenom.ilike.%${args.query}%,entreprise.ilike.%${args.query}%`)
                .eq("actif", true)
                .order("updated_at", { ascending: false })
                .limit(10);

            if (error) return { error: error.message };
            return { clients: data || [], count: (data || []).length };
        }

        case "create_sav_request": {
            const { data, error } = await db
                .from("sav_requests")
                .insert({
                    client_id: args.client_id,
                    client_name: args.client_name,
                    phone: args.phone || null,
                    address: args.address || null,
                    system_type: args.system_type || "autre",
                    problem_desc: args.problem_desc,
                    urgent: args.urgent || false,
                    status: "nouveau",
                })
                .select("id, client_name, status, system_type, problem_desc")
                .single();

            if (error) return { error: error.message };
            return { success: true, sav_request: data };
        }

        case "create_opportunity": {
            const { data, error } = await db
                .from("opportunites")
                .insert({
                    client_id: args.client_id,
                    titre: args.titre,
                    description: args.description || "",
                    montant_estime: args.montant_estime || null,
                    suivi_par: args.suivi_par || "Quentin",
                    statut: "nouveau",
                })
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

            const stats: Record<string, number> = { total: 0, nouveau: 0, en_cours: 0, termine: 0, archive: 0 };
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

    for (const part of candidate.content.parts) {
        if (part.functionCall) {
            const { name, args } = part.functionCall;
            const result = await executeTool(name, args || {});

            // If HITL needed, return immediately
            if (result?._hitl) {
                delete result._hitl;
                return result;
            }

            // Feed result back to Gemini
            messages.push({
                role: "model",
                parts: [{ functionCall: { name, args: args || {} } }],
            });
            messages.push({
                role: "user",
                parts: [{ functionResponse: { name, response: result } }],
            });

            // Call Gemini again with the tool result
            let followUp;
            try {
                followUp = await callGemini(messages, TOOLS);
            } catch (error) {
                console.error("Gemini follow-up failed:", error);
                // If a write tool succeeded, still report success
                if (result?.success) {
                    return { type: "success", message: `Action réalisée avec succès.` };
                }
                return { type: "error", message: "Erreur lors du traitement." };
            }

            // Recursively process the follow-up
            return processGeminiResponse(followUp, messages, depth + 1);
        }

        if (part.text) {
            return { type: "text", message: part.text };
        }
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
            geminiMessages.push({
                role: "user",
                parts: [{ text: "L'utilisateur a confirmé. Exécute l'action maintenant." }],
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
