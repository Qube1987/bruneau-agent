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
async function callGemini(messages: any[], tools: any[], toolConfig?: any) {
    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) throw new Error("GEMINI_API_KEY not configured");

    const requestBody: any = {
        contents: messages,
        tools: tools.length > 0 ? [{ functionDeclarations: tools }] : undefined,
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        generationConfig: { temperature: 0.3, topP: 0.8, maxOutputTokens: 2048 },
    };
    if (toolConfig) requestBody.toolConfig = toolConfig;

    const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
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
2. Utiliser les bons outils (function calls) pour réaliser les actions demandées — NE JAMAIS simuler une action, TOUJOURS appeler le tool correspondant
3. Pour les SAV et opportunités : demander confirmation via ask_user_confirmation AVANT de créer/modifier
4. Pour les RENDEZ-VOUS : appeler DIRECTEMENT create_appointment SANS ask_user_confirmation
5. Être concis dans tes réponses (elles seront lues à voix haute)

RÈGLES IMPORTANTES :
- Pour les SAV/opportunités : utilise ask_user_confirmation AVANT toute création ou modification
- Pour les RENDEZ-VOUS : appelle DIRECTEMENT create_appointment ou delete_appointment SANS confirmation
- CRITIQUE : tu ne dois JAMAIS dire que tu as créé quelque chose sans avoir appelé le tool correspondant. Si tu ne fais pas de function call, le RDV n'est PAS créé.
- Si tu trouves plusieurs clients correspondants, utilise ask_user_selection pour proposer la liste
- Si des informations manquent pour créer un enregistrement, demande-les à l'utilisateur
- Utilise un français naturel et professionnel
- Sois bref : ta réponse sera lue à voix haute
- "centrale" ou "centrale d'alarme" fait référence au système d'intrusion
- Quand on te dit "pile HS" ou "batterie HS", le system_type est souvent "intrusion"
- Quand on te demande de "créer un SAV", c'est une sav_request
- FLUX DE CRÉATION SAV : 1) search_client 2) list_users 3) ask_user_selection avec les utilisateurs formatés en options [{label: display_name, subtitle: role, value: id}] pour demander à qui assigner 4) ask_user_confirmation avec TOUS les détails dont assigned_user_id et assigned_user_name 5) create_sav_request
- FLUX DE CRÉATION OPPORTUNITÉ : 1) search_client (cherche le client mentionné) 2) si plusieurs résultats, ask_user_selection 3) ask_user_confirmation avec tous les détails 4) create_opportunity
- FLUX DE MODIFICATION STOCK : 1) check_stock pour trouver le produit 2) si plusieurs résultats, ask_user_selection pour que l'utilisateur choisisse lequel modifier 3) ask_user_confirmation avec le nom du produit, la quantité actuelle, la modification demandée et la nouvelle quantité résultante 4) update_stock_quantity
- Les emplacements stock sont : depot (dépôt principal), paul_truck (camion Paul), quentin_truck (camion Quentin). Si l'emplacement n'est pas précisé, utiliser depot.
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

AGENDA / RENDEZ-VOUS :
- L'agenda est géré via l'API Extrabat. Chaque utilisateur a un code Extrabat lié.
- Correspondance des membres de l'équipe : Quentin (46516), Paul (218599), Cindy (47191), Téo (485533)
- Quand l'utilisateur dit "mon agenda" ou "mes rendez-vous" sans préciser de nom, utilise le code de Quentin (46516) par défaut
- Quand on te demande l'agenda de Paul, utilise directement son code (218599) sans demander de précision
- Pour les dates : "demain" = jour suivant, "lundi prochain" = prochain lundi, "cet après-midi" = aujourd'hui 14:00-18:00, "cette semaine" = du lundi au vendredi de la semaine courante
- La date/heure actuelle est fournie dans le contexte. Utilise-la pour calculer les dates relatives.
- CRÉER UN RDV = OBLIGATOIREMENT appeler create_appointment (function call). Ne JAMAIS répondre en texte que le RDV est créé sans function call.
- Pour les RDV, le format de date est TOUJOURS "YYYY-MM-DD HH:MM:SS" (avec espace, PAS de T)
- Si l'utilisateur ne précise pas la durée, mettre 1h par défaut (fin = debut + 1h)
- Si l'utilisateur ne précise pas de nom, c'est pour Quentin (défaut)
- Exemple : si l'utilisateur dit "ajoute un rdv coiffeur mardi à 16h" → appeler create_appointment({objet: "Coiffeur", debut: "2026-03-10 16:00:00", fin: "2026-03-10 17:00:00"})

RECHERCHE DE CLIENTS :
- search_client cherche d'abord dans la base Supabase locale, puis dans Extrabat si pas assez de résultats
- Chaque client retourné a un champ "source" ("supabase" ou "extrabat")
- Les clients "supabase" ont un UUID valide comme id, utilisable directement pour créer des SAV ou opportunités
- Les clients "extrabat" ont un id au format "extrabat-XXXX" — Ce n'est PAS un UUID valide ! Tu ne peux PAS l'utiliser directement dans client_id pour create_sav_request ou create_opportunity
- Si l'utilisateur choisit un client "extrabat", précise-lui que ce client n'est pas encore dans la base locale et que le SAV/opportunité ne peut pas être lié automatiquement. Propose de créer le SAV avec les infos du client (nom, téléphone, adresse) mais SANS client_id (passe null)
- Quand tu proposes la liste des clients à l'utilisateur via ask_user_selection, indique la source. Exemple : "Pages Jean (Supabase)" ou "Pages Jean (Extrabat)"

FORMAT DES RÉPONSES POUR LES LISTES :
- Quand tu retournes une liste, formate-la avec UN ÉLÉMENT PAR LIGNE en utilisant des tirets (-) ou des puces
- Indique toujours le nombre total de résultats en introduction
- Pour les SAV, une ligne par SAV :
  - Client | Problème | Statut | Date
- Pour les opportunités, une ligne par opportunité :
  - Client | Titre | Statut | Suivi par
- Pour le STOCK (check_stock) :
  - Tu DOIS lister CHAQUE produit retourné par l'outil, UN PAR LIGNE
  - Format par ligne : "- NomProduit (Marque) : X total (dépôt: X, Paul: X, Quentin: X)"
  - Si le total est 0, ajoute "⚠️ RUPTURE"
  - INTERDIT de résumer ou d'omettre des produits. Si check_stock retourne 6 produits, tu dois en lister 6.
  - INTERDIT de ne mentionner qu'un seul produit quand il y en a plusieurs.
  - Exemple correct pour "centrales ajax" :
    "📦 6 centrales Ajax trouvées :
    - Hub2+-B (Ajax) : 0 total (dépôt: 0) ⚠️ RUPTURE
    - Hub2+-W (Ajax) : 0 total (dépôt: 0) ⚠️ RUPTURE
    - Hub2 4G-B (Ajax) : 1 total (dépôt: 1)
    - Hub2 4G-W (Ajax) : 0 total (dépôt: 0) ⚠️ RUPTURE
    - Hub Hybrid 4G-B (Ajax) : 1 total (dépôt: 1)
    - Hub Hybrid 4G-W (Ajax) : 2 total (dépôt: 2)"
- Pour l'AGENDA (get_agenda) :
  - Liste chaque RDV sur une ligne : "- HH:MM - HH:MM : Objet (Client si disponible)"
  - Si le jour est vide, indique "Aucun rendez-vous"
  - Quand on demande "de la place" ou des "disponibilités", analyse les créneaux et indique les plages libres (horaires 7h-18h)
- Limite à 15 éléments max, mentionne s'il y en a plus

STRUCTURE DE LA BASE :
- Table "clients" : clients unifiés (id, nom, prenom, email, telephone, adresse, code_postal, ville, civilite, entreprise, client_type, source, actif)
- Table "sav_requests" : demandes SAV (id, client_id, client_name, phone, address, system_type, problem_desc, status[nouvelle/en_cours/terminee/archivee], urgent, priority, assigned_user_id, requested_at, resolved_at, billing_status)
- Table "opportunites" : opportunités commerciales (id, client_id, titre, description, statut[a-contacter/contacte/recueil-besoin/redaction-devis/devis-transmis/relance-1/relance-2/relance-3], suivi_par, montant_estime, statut_final[gagne/perdu/standby], archive, prioritaire, date_creation)
- Table "maintenance_contracts" : contrats de maintenance (id, client_id, client_name, system_type, system_brand, status[actif/inactif], address, annual_amount, billing_mode, invoice_sent, invoice_paid)
- Table "stock_products" : stock (id, name, code_article, marque, fournisseur, depot_quantity, min_quantity, paul_truck_quantity, quentin_truck_quantity)
- Table "stock_movements" : historique des mouvements stock (id, stock_product_id, movement_type[entrée/sortie/ajustement/transfert], location[depot/paul_truck/quentin_truck], quantity_change, comment, created_at)
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
        name: "update_stock_quantity",
        description: "Modifier la quantité d'un produit en stock. IMPORTANT: appeler check_stock d'abord pour trouver le produit, puis ask_user_confirmation AVANT de modifier. Les emplacements possibles sont: depot, paul_truck, quentin_truck.",
        parameters: {
            type: "OBJECT",
            properties: {
                product_id: { type: "STRING", description: "UUID du produit stock (obtenu via check_stock)" },
                location: { type: "STRING", description: "Emplacement: depot, paul_truck, quentin_truck (défaut: depot)" },
                quantity_change: { type: "NUMBER", description: "Modification de quantité. Négatif pour retirer (ex: -1), positif pour ajouter (ex: +3)" },
                comment: { type: "STRING", description: "Commentaire/raison de la modification (ex: 'utilisé sur chantier', 'réapprovisionnement')" },
            },
            required: ["product_id", "quantity_change"],
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

    // ===== AGENDA =====
    {
        name: "get_agenda",
        description: "Consulter l'agenda / les rendez-vous d'un membre de l'équipe. Utilise cet outil quand on demande les rdv, l'agenda, les disponibilités, la place dans l'agenda.",
        parameters: {
            type: "OBJECT",
            properties: {
                user_name: { type: "STRING", description: "Nom de la personne (Quentin, Paul, Cindy, Téo). Défaut: Quentin" },
                date_debut: { type: "STRING", description: "Date de début au format YYYY-MM-DD. Défaut: aujourd'hui" },
                date_fin: { type: "STRING", description: "Date de fin au format YYYY-MM-DD. Défaut: même jour que date_debut" },
            },
        },
    },
    {
        name: "create_appointment",
        description: "Créer un rendez-vous dans l'agenda Extrabat. Appeler DIRECTEMENT cet outil (pas besoin de ask_user_confirmation). Calcule les dates à partir du contexte fourni.",
        parameters: {
            type: "OBJECT",
            properties: {
                user_name: { type: "STRING", description: "Nom de la personne (Quentin, Paul, Cindy, Téo). Défaut: Quentin" },
                objet: { type: "STRING", description: "Objet / titre du rendez-vous" },
                debut: { type: "STRING", description: "Date et heure de début au format YYYY-MM-DD HH:MM:SS" },
                fin: { type: "STRING", description: "Date et heure de fin au format YYYY-MM-DD HH:MM:SS" },
                journee: { type: "BOOLEAN", description: "Si true, le rdv dure toute la journée (défaut: false)" },
            },
            required: ["objet", "debut", "fin"],
        },
    },
    {
        name: "delete_appointment",
        description: "Supprimer un rendez-vous de l'agenda Extrabat. IMPORTANT: appeler ask_user_confirmation d'abord.",
        parameters: {
            type: "OBJECT",
            properties: {
                appointment_id: { type: "STRING", description: "ID du rendez-vous à supprimer" },
            },
            required: ["appointment_id"],
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
        description: "Demander confirmation à l'utilisateur AVANT toute action d'écriture. OBLIGATOIRE avant create/update/delete.",
        parameters: {
            type: "OBJECT",
            properties: {
                message: { type: "STRING", description: "Message de confirmation clair pour l'utilisateur" },
                action_type: { type: "STRING", description: "Type d'action : create_sav, create_opportunity, create_rdv, update_sav, update_opportunity, delete_rdv, update_stock" },
                details: { type: "STRING", description: "JSON string des détails à confirmer. Pour un RDV: {\"objet\": \"...\", \"debut\": \"YYYY-MM-DD HH:MM:SS\", \"fin\": \"YYYY-MM-DD HH:MM:SS\", \"user_name\": \"Quentin\"}. Pour update_stock: {\"product_name\": \"...\", \"product_id\": \"...\", \"location\": \"depot\", \"current_quantity\": 5, \"quantity_change\": -1, \"new_quantity\": 4}" },
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

// --- Extrabat user code mapping ---
const EXTRABAT_USERS: Record<string, string> = {
    "quentin": "46516", "paul": "218599", "cindy": "47191", "téo": "485533", "teo": "485533",
};

function getExtrabatCode(name?: string): string {
    if (!name) return "46516"; // Default: Quentin
    const clean = name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    for (const [key, code] of Object.entries(EXTRABAT_USERS)) {
        const cleanKey = key.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        if (clean.includes(cleanKey)) return code;
    }
    return "46516"; // Fallback: Quentin
}

async function callExtrabat(method: string, path: string, body?: any): Promise<any> {
    const apiKey = Deno.env.get("EXTRABAT_API_KEY");
    const securityKey = Deno.env.get("EXTRABAT_SECURITY");
    if (!apiKey || !securityKey) return { error: "Extrabat API credentials not configured" };

    const url = `https://api.extrabat.com${path}`;
    console.log(`Extrabat ${method} ${url}`, body ? JSON.stringify(body) : "");

    const opts: any = {
        method,
        headers: {
            "Content-Type": "application/json",
            "X-EXTRABAT-API-KEY": apiKey,
            "X-EXTRABAT-SECURITY": securityKey,
        },
    };
    if (body) opts.body = JSON.stringify(body);

    try {
        const response = await fetch(url, opts);
        const text = await response.text();
        console.log(`Extrabat response status=${response.status}, body="${text.substring(0, 500)}"`);

        let data: any;
        if (!text || text.trim() === "") {
            data = { success: true, status: response.status };
        } else {
            try { data = JSON.parse(text); } catch { data = text; }
        }

        if (!response.ok) {
            console.error("Extrabat API error:", response.status, data);
            return { error: `Extrabat API error: ${response.status} - ${typeof data === 'string' ? data : JSON.stringify(data)}` };
        }
        return data;
    } catch (fetchError: any) {
        console.error("Extrabat fetch error:", fetchError);
        return { error: `Extrabat network error: ${fetchError?.message || fetchError}` };
    }
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

        // ===== CHECK STOCK (load all, score, filter) =====
        case "check_stock": {
            const searchTerms = args.query.split(/\s+/).filter((w: string) => w.length > 1);

            // Load ALL stock products with subcategory/category info (< 300 products total)
            const { data: allProducts, error } = await db.from("stock_products")
                .select("id, name, code_article, marque, fournisseur, depot_quantity, min_quantity, paul_truck_quantity, quentin_truck_quantity, stock_subcategories(name, stock_categories(name))")
                .limit(500);

            if (error) return { error: error.message };

            // Score each product: how many search terms match across ALL fields
            const scored = (allProducts || []).map((p: any) => {
                const subcat = p.stock_subcategories?.name || "";
                const cat = p.stock_subcategories?.stock_categories?.name || "";
                const searchable = `${p.name} ${p.marque} ${p.fournisseur} ${p.code_article} ${subcat} ${cat}`.toLowerCase();
                const matchCount = searchTerms.filter((t: string) => searchable.includes(t.toLowerCase())).length;
                const total = (p.depot_quantity || 0) + (p.paul_truck_quantity || 0) + (p.quentin_truck_quantity || 0);
                return {
                    id: p.id, name: p.name, code_article: p.code_article,
                    marque: p.marque, fournisseur: p.fournisseur,
                    category: cat, subcategory: subcat,
                    depot_quantity: p.depot_quantity || 0,
                    paul_truck_quantity: p.paul_truck_quantity || 0,
                    quentin_truck_quantity: p.quentin_truck_quantity || 0,
                    total_quantity: total, min_quantity: p.min_quantity || 0,
                    is_low: total < (p.min_quantity || 0),
                    _score: matchCount,
                };
            }).filter((p: any) => p._score > 0);

            // Sort by score desc (products matching ALL terms first)
            scored.sort((a: any, b: any) => b._score - a._score);

            // Prefer products matching ALL search terms; fallback to partial matches
            const maxScore = scored.length > 0 ? scored[0]._score : 0;
            const topResults = maxScore === searchTerms.length
                ? scored.filter((r: any) => r._score === searchTerms.length).slice(0, 20)
                : scored.slice(0, 20);

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

        // ===== UPDATE STOCK QUANTITY =====
        case "update_stock_quantity": {
            const productId = args?.product_id;
            const location = args?.location || "depot";
            const quantityChange = parseInt(args?.quantity_change);
            const comment = args?.comment || "Modification via agent";

            if (!productId) return { error: "product_id requis" };
            if (isNaN(quantityChange) || quantityChange === 0) return { error: "quantity_change invalide (doit être un nombre non nul)" };

            // Map location to column name
            const columnMap: Record<string, string> = {
                depot: "depot_quantity",
                paul_truck: "paul_truck_quantity",
                quentin_truck: "quentin_truck_quantity",
            };
            const column = columnMap[location];
            if (!column) return { error: `Emplacement invalide: ${location}. Utiliser: depot, paul_truck, quentin_truck` };

            // Get current quantity
            const { data: product, error: fetchError } = await db
                .from("stock_products")
                .select("id, name, depot_quantity, paul_truck_quantity, quentin_truck_quantity")
                .eq("id", productId)
                .single();
            if (fetchError || !product) return { error: fetchError?.message || "Produit non trouvé" };

            const currentQty = (product as any)[column] || 0;
            const newQty = currentQty + quantityChange;
            if (newQty < 0) return { error: `Quantité insuffisante. Stock actuel ${location}: ${currentQty}, modification demandée: ${quantityChange}` };

            // Update quantity
            const { error: updateError } = await db
                .from("stock_products")
                .update({ [column]: newQty })
                .eq("id", productId);
            if (updateError) return { error: updateError.message };

            // Insert movement record
            const movementType = quantityChange > 0 ? "entrée" : "sortie";
            await db.from("stock_movements").insert({
                stock_product_id: productId,
                movement_type: movementType,
                location,
                quantity_change: quantityChange,
                comment: `[Agent] ${comment}`,
            });

            const locationLabels: Record<string, string> = { depot: "Dépôt", paul_truck: "Camion Paul", quentin_truck: "Camion Quentin" };
            return {
                success: true,
                product_name: (product as any).name,
                location: locationLabels[location] || location,
                previous_quantity: currentQty,
                quantity_change: quantityChange,
                new_quantity: newQty,
                message: `Stock mis à jour : ${(product as any).name} (${locationLabels[location] || location}) : ${currentQty} → ${newQty} (${quantityChange > 0 ? '+' : ''}${quantityChange})`,
            };
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

        // ===== GET AGENDA =====
        case "get_agenda": {
            const extrabatCode = getExtrabatCode(args.user_name);
            const today = new Date().toISOString().split("T")[0];
            const dateDebut = args.date_debut || today;
            const dateFin = args.date_fin || dateDebut;
            const userName = args.user_name || "Quentin";

            // Call extrabat-proxy (same approach as SAV app's useCalendar)
            const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
            const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

            const proxyResponse = await fetch(`${supabaseUrl}/functions/v1/extrabat-proxy`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${supabaseKey}`,
                },
                body: JSON.stringify({
                    endpoint: `utilisateur/${extrabatCode}/rendez-vous`,
                    apiVersion: "v1",
                    params: {
                        date_debut: dateDebut,
                        date_fin: dateFin,
                        include: "client",
                    },
                }),
            });

            const proxyData = await proxyResponse.json();
            console.log("get_agenda proxy response:", JSON.stringify(proxyData).substring(0, 500));

            if (!proxyData.success) return { error: proxyData.error || "Erreur récupération agenda" };

            const appointments = Array.isArray(proxyData.data) ? proxyData.data : (proxyData.data ? Object.values(proxyData.data) : []);
            const formatted = (appointments as any[]).map((apt: any) => ({
                id: apt.id, objet: apt.objet, debut: apt.debut, fin: apt.fin, journee: apt.journee,
                clients: apt.clients || [],
            }));
            formatted.sort((a: any, b: any) => new Date(a.debut).getTime() - new Date(b.debut).getTime());

            return { user: userName, date_debut: dateDebut, date_fin: dateFin, appointments: formatted, count: formatted.length };
        }

        // ===== CREATE APPOINTMENT =====
        case "create_appointment": {
            const extrabatCode = getExtrabatCode(args.user_name);
            const userName = args.user_name || "Quentin";

            // Parse debut/fin into proper Date objects
            const parseDate = (d: string): Date => {
                if (!d) return new Date();
                // Handle "YYYY-MM-DD HH:MM:SS" or "YYYY-MM-DDTHH:MM:SS"
                return new Date(d.replace(" ", "T"));
            };

            const startDate = parseDate(args.debut);
            const endDate = args.fin ? parseDate(args.fin) : new Date(startDate.getTime() + 60 * 60 * 1000); // default 1h

            console.log(`Creating appointment via extrabat-proxy: objet="${args.objet}", start=${startDate.toISOString()}, end=${endDate.toISOString()}, user=${extrabatCode} (${userName})`);

            // Call extrabat-proxy with the SAME format as the SAV app's useExtrabat.createAppointment
            const supabaseUrl2 = Deno.env.get("SUPABASE_URL")!;
            const supabaseKey2 = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

            const proxyResponse2 = await fetch(`${supabaseUrl2}/functions/v1/extrabat-proxy`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${supabaseKey2}`,
                },
                body: JSON.stringify({
                    technicianCodes: [extrabatCode],
                    interventionData: {
                        clientName: args.objet,
                        systemType: "",
                        problemDesc: args.objet,
                        startedAt: startDate.toISOString(),
                        endedAt: endDate.toISOString(),
                    },
                }),
            });

            const proxyResult = await proxyResponse2.json();
            console.log("create_appointment proxy response:", JSON.stringify(proxyResult));

            if (!proxyResult.success) {
                return { error: proxyResult.error || "Erreur création RDV Extrabat" };
            }

            return {
                success: true,
                message: `Rendez-vous "${args.objet}" créé pour ${userName}`,
                appointment_id: proxyResult.data?.id || proxyResult.data,
                details: { objet: args.objet, debut: startDate.toISOString(), fin: endDate.toISOString(), user: userName },
            };
        }

        // ===== DELETE APPOINTMENT =====
        case "delete_appointment": {
            const supabaseUrl3 = Deno.env.get("SUPABASE_URL")!;
            const supabaseKey3 = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

            const proxyResponse3 = await fetch(`${supabaseUrl3}/functions/v1/extrabat-proxy`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${supabaseKey3}`,
                },
                body: JSON.stringify({
                    action: "deleteAppointment",
                    appointmentId: args.appointment_id,
                }),
            });

            const proxyResult3 = await proxyResponse3.json();
            console.log("delete_appointment proxy response:", JSON.stringify(proxyResult3));

            if (!proxyResult3.success) return { error: proxyResult3.error || "Erreur suppression RDV" };

            return {
                success: true,
                message: `Rendez-vous ${args.appointment_id} supprimé`,
            };
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

    console.log(`processGeminiResponse depth=${depth}: ${functionCalls.length} function calls, ${textParts.length} text parts`);
    if (functionCalls.length > 0) {
        console.log("Function calls:", functionCalls.map((fc: any) => `${fc.functionCall.name}(${JSON.stringify(fc.functionCall.args).substring(0, 200)})`).join(", "));
    }
    if (textParts.length > 0 && functionCalls.length === 0) {
        console.log("Text response (first 300 chars):", textParts.map((p: any) => p.text).join(" ").substring(0, 300));
    }

    if (functionCalls.length === 0) {
        const text = textParts.map((p: any) => p.text).join("\n");
        const textLower = text.toLowerCase();

        // RETRY: If Gemini responded with text about creating a RDV without calling the tool, force function call
        const isRdvRequest = textLower.includes("rendez-vous") || textLower.includes("rdv") || textLower.includes("créé") || textLower.includes("ajouté");
        if (isRdvRequest && depth === 0) {
            console.log("RETRY: Gemini responded with text about RDV instead of calling tool. Forcing function call...");
            // Add a strong instruction and retry with forced function calling
            const retryMessages = [...messages,
            { role: "model", parts: [{ text }] },
            { role: "user", parts: [{ text: "ERREUR: tu as répondu en TEXTE au lieu d'appeler le tool create_appointment. Tu DOIS faire un function call create_appointment maintenant. Ne réponds PAS en texte." }] }
            ];
            try {
                const retryResult = await callGemini(retryMessages, TOOLS, {
                    functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["create_appointment", "get_agenda", "delete_appointment"] }
                });
                return processGeminiResponse(retryResult, retryMessages, depth + 1);
            } catch (e) {
                console.error("Retry failed:", e);
            }
        }

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
        // Inject current date/time context for date-relative queries
        const now = new Date();
        const days = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
        const dayName = days[now.getDay()];
        const dateContext = `[Contexte : nous sommes ${dayName} ${now.toISOString().split("T")[0]}, il est ${now.toTimeString().slice(0, 5)}]`;
        geminiMessages.push({ role: "user", parts: [{ text: `${dateContext}\n${message}` }] });
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

            // Direct appointment creation - broad matching
            if (
                (pending.includes("appointment") || pending.includes("rdv") || pending.includes("rendez") || pending.includes("agenda") || pending.includes("coiffeur") || pending.includes("clinique"))
                || (details.debut && details.objet) // fallback: if details have debut + objet, it's an appointment
            ) {
                if (details.objet && details.debut) {
                    console.log("HITL: Creating appointment from details:", JSON.stringify(details));
                    const result = await executeTool("create_appointment", {
                        user_name: details.user_name || null,
                        objet: details.objet,
                        debut: details.debut,
                        fin: details.fin || details.debut, // fallback: same as debut if missing
                        journee: details.journee || false,
                    });
                    if (result?.success) return { type: "success", message: result.message || `Rendez-vous créé avec succès.` };
                    return { type: "error", message: `Erreur création RDV : ${result?.error || "inconnue"}` };
                }
            }

            // Direct appointment deletion
            if (pending.includes("delete") && (pending.includes("appointment") || pending.includes("rdv")) && details.appointment_id) {
                const result = await executeTool("delete_appointment", {
                    appointment_id: details.appointment_id,
                });
                if (result?.success) return { type: "success", message: result.message || `Rendez-vous supprimé.` };
                return { type: "error", message: `Erreur suppression RDV : ${result?.error || "inconnue"}` };
            }

            // Fallback - send back to Gemini with confirmation context
            console.log("HITL confirm fallback — no direct execution match. pending:", pending, "details:", JSON.stringify(details));
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
        // Detect if the user message is about creating/managing an appointment
        const lastUserMsg = (message || "").toLowerCase();
        const hasActionVerb = /\b(ajoute|ajout|cr[eé][eé]|planifie|programme|mets|mettre|supprime|pose|fixe|cale|bloque|r[eé]serve|pr[eé]vois|note)\b/.test(lastUserMsg);
        const hasRdvKeyword = /\b(rdv|rendez|agenda|coiffeur|clinique|r[eé]union|meeting|rendez-vous|dentiste|m[eé]decin|docteur|visite|cr[eé]neau|intervention)\b/.test(lastUserMsg);
        const isAgendaRelated = hasActionVerb && hasRdvKeyword;

        let toolConfig = undefined;
        if (isAgendaRelated) {
            console.log("FORCED FUNCTION CALLING: Detected appointment request in message:", lastUserMsg.substring(0, 100));
            toolConfig = {
                functionCallingConfig: {
                    mode: "ANY",
                    allowedFunctionNames: ["create_appointment", "delete_appointment", "get_agenda"]
                }
            };
        }

        const geminiResult = await callGemini(cleanMessages, TOOLS, toolConfig);
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

        // TEST ENDPOINT: bypass Gemini entirely
        if (body._test === "create_rdv") {
            console.log("TEST: Direct create_appointment call");
            const result = await executeTool("create_appointment", {
                user_name: body.user_name || "Quentin",
                objet: body.objet || "RDV TEST",
                debut: body.debut || "2026-03-09 15:30:00",
                fin: body.fin || "2026-03-09 16:30:00",
            });
            return new Response(JSON.stringify({ test: true, result }), {
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
        }

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
