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
        generationConfig: {
            temperature: 0.3,
            topP: 0.8,
            maxOutputTokens: 8192,
            thinkingConfig: { thinkingBudget: 1024 },
        },
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
- IMPORTANT : Quand l'utilisateur demande les INFOS ou la FICHE d'un client spécifique (pas juste une recherche), utilise get_client_details avec le client_id pour obtenir la fiche complète (contacts, sites/adresses, contrats maintenance, SAV, opportunités)
- get_client_details retourne TOUTES les données liées au client. Présente-les de façon structurée : d'abord les infos générales, puis les contacts, les sites/adresses, les contrats de maintenance, les SAV, etc.

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
- Table "client_contacts" : contacts d'un client (id, client_id, nom, prenom, telephone, email, fonction, principal). Un client professionnel peut avoir PLUSIEURS contacts.
- Table "client_sites" : sites/bâtiments d'un client (id, client_id, label, adresse, code_postal, ville, system_type, system_brand, system_model, principal). Un client peut avoir PLUSIEURS sites à des adresses différentes.
- Table "sav_requests" : demandes SAV (id, client_id, site_id, client_name, site, phone, address, system_type, system_brand, problem_desc, status[nouvelle/en_cours/terminee/archivee], urgent, priority, assigned_user_id, requested_at, resolved_at, billing_status)
- Table "opportunites" : opportunités commerciales (id, client_id, titre, description, statut[a-contacter/contacte/recueil-besoin/redaction-devis/devis-transmis/relance-1/relance-2/relance-3], suivi_par, montant_estime, statut_final[gagne/perdu/standby], archive, prioritaire, date_creation)
- Table "maintenance_contracts" : contrats de maintenance (id, client_id, site_id, client_name, site, system_type, system_brand, status[actif/inactif], address, city_derived, annual_amount, billing_mode, invoice_sent, invoice_paid)
- Table "stock_products" : stock (id, name, code_article, marque, fournisseur, depot_quantity, min_quantity, paul_truck_quantity, quentin_truck_quantity)
- Table "stock_movements" : historique des mouvements stock (id, stock_product_id, movement_type[entrée/sortie/ajustement/transfert], location[depot/paul_truck/quentin_truck], quantity_change, comment, created_at)
- Table "devis" : devis (id, client_id, devis_number, devis_type, status[brouillon/envoye/accepte/refuse/draft/sent/signed], titre_affaire, client(jsonb: nom, prenom, email, telephone, adresse), lignes(jsonb: tableau produits), totaux(jsonb: ht, ttc, tva, acompte), accepted_status[pending/accepted], public_token)
- Table "call_notes" : notes d'appels (id, client_name, call_subject, notes, is_completed, priority)

DEVIS (QUOTES) :
- Quand on te demande "le devis Le Bras", "montre-moi le devis de M. Dupont", ou "les devis en cours", utilise search_devis ou list_devis
- search_devis cherche par nom de client dans le champ JSONB client->>'nom' de la table devis
- get_devis_details retourne le détail complet d'un devis : client, lignes de produits, totaux, statut d'acceptation
- Pour les devis, présente les infos de façon structurée : client, titre, puis liste des produits avec quantités et prix, puis totaux (HT, TVA, TTC, acompte)
- Les statuts de devis : brouillon/draft = en cours de rédaction, envoye/sent = envoyé au client, accepte/signed = signé par le client, refuse = refusé
- accepted_status : pending = en attente, accepted = accepté par le client
- Le lien public vers un devis est disponible via le public_token

ENVOI DE SMS ET EMAILS :
- Quand l'utilisateur demande d'envoyer un SMS ou un email, utilise compose_sms ou compose_email
- Ces outils cherchent AUTOMATIQUEMENT le destinataire dans les clients ET les membres de l'équipe (table users)
- Tu dois fournir : le nom du destinataire (recipient_name), le message (body), et pour les emails l'objet (subject)
- L'outil va chercher le numéro de téléphone ou l'email du destinataire automatiquement
- Si plusieurs destinataires correspondent, l'outil retournera une erreur avec les options — utilise alors ask_user_selection
- Le message sera pré-rempli et l'utilisateur pourra le modifier avant envoi dans l'appli SMS/Mail native de son téléphone
- Les membres de l'équipe : Quentin (quentin@bruneau27.com, +33684516668), Paul (paul@bruneau27.com, +33681082597), Cindy (cindy@bruneau27.com, +33601420609), Téo (teo@bruneau27.com)
- IMPORTANT pour le TON des messages :
  - Messages à l'ÉQUIPE (Paul, Cindy, Téo, Quentin) : tutoiement, ton informel et direct, PAS de "Cordialement", PAS de signature, PAS de formule de politesse. Ex: "Salut Paul, tu peux passer au dépôt demain matin ?"
  - Messages aux CLIENTS : vouvoiement, ton professionnel, signe avec "Cordialement,\nQuentin Bruneau\nSté Bruneau Protection"
- Pour les SMS (équipe ou clients), sois concis (160 caractères idéal, 300 max)

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
                status: { type: "STRING", description: "Filtrer par statut : brouillon, draft, envoye, sent, accepte, signed, refuse. Laisser vide pour tous." },
                period: { type: "STRING", description: "Période : today, week, month. Laisser vide pour tous." },
                search: { type: "STRING", description: "Rechercher par nom de client (cherche dans le champ client JSONB et dans la table clients liée)" },
                limit: { type: "NUMBER", description: "Nombre max de résultats (défaut: 20)" },
            },
        },
    },
    {
        name: "search_devis",
        description: "Rechercher un devis par nom de client. Utilise cet outil quand on demande 'le devis Le Bras', 'le devis de M. Dupont', etc. Cherche dans le champ client JSONB du devis.",
        parameters: {
            type: "OBJECT",
            properties: {
                query: { type: "STRING", description: "Nom (ou partie du nom) du client à rechercher dans les devis" },
            },
            required: ["query"],
        },
    },
    {
        name: "get_devis_details",
        description: "Obtenir le détail COMPLET d'un devis : infos client, lignes de produits avec prix et quantités, totaux (HT, TVA, TTC, acompte), statut d'acceptation. Utiliser quand l'utilisateur veut voir un devis spécifique.",
        parameters: {
            type: "OBJECT",
            properties: {
                devis_id: { type: "STRING", description: "UUID du devis à consulter" },
            },
            required: ["devis_id"],
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
        name: "get_client_details",
        description: "Obtenir la fiche COMPLÈTE d'un client : infos de base, contacts, sites/adresses, contrats de maintenance, SAV, opportunités. Utiliser quand l'utilisateur demande les infos, la fiche, ou les détails d'un client spécifique.",
        parameters: {
            type: "OBJECT",
            properties: {
                client_id: { type: "STRING", description: "UUID du client Supabase" },
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
                product_name: { type: "STRING", description: "Nom exact du produit (pour fallback si l'ID est invalide)" },
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
                suivi_par: { type: "STRING", description: "Personne en charge. Valeurs possibles: Quentin BRUNEAU, Paul PICARD, Cindy BRUNEAU, Hugo COSTES, Téo BRIERE. (défaut: Quentin BRUNEAU). IMPORTANT: utiliser le nom complet 'Prénom NOM'." },
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

    // ===== COMPOSE SMS / EMAIL =====
    {
        name: "compose_sms",
        description: "Préparer un SMS à envoyer via l'application SMS native du téléphone. Cherche automatiquement le destinataire dans les clients ET les membres de l'équipe. L'utilisateur pourra modifier le message avant envoi.",
        parameters: {
            type: "OBJECT",
            properties: {
                recipient_name: { type: "STRING", description: "Nom du destinataire (client ou membre de l'équipe)" },
                body: { type: "STRING", description: "Contenu du SMS" },
            },
            required: ["recipient_name", "body"],
        },
    },
    {
        name: "compose_email",
        description: "Préparer un email à envoyer via l'application mail native du téléphone. Cherche automatiquement le destinataire dans les clients ET les membres de l'équipe. L'utilisateur pourra modifier le message avant envoi.",
        parameters: {
            type: "OBJECT",
            properties: {
                recipient_name: { type: "STRING", description: "Nom du destinataire (client ou membre de l'équipe)" },
                subject: { type: "STRING", description: "Objet de l'email" },
                body: { type: "STRING", description: "Contenu de l'email" },
            },
            required: ["recipient_name", "subject", "body"],
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
        // Collect ALL phones
        const telephones: any[] = [];
        if (client.telephones?.length > 0) {
            for (const tel of client.telephones) {
                const num = tel.number || tel.numero || "";
                if (num) telephones.push({ numero: num, type: tel.type?.libelle || tel.typeTelephone?.libelle || "" });
            }
        }
        const telephone = telephones.length > 0 ? telephones[0].numero : "";

        // Collect ALL addresses
        const adresses: any[] = [];
        if (client.adresses?.length > 0) {
            for (const addr of client.adresses) {
                adresses.push({
                    adresse: addr.description || addr.adresse || addr.rue || "",
                    code_postal: addr.codePostal || addr.code_postal || "",
                    ville: addr.ville || "",
                    type: addr.type?.libelle || addr.typeAdresse?.libelle || "",
                });
            }
        }
        const adresse = adresses.length > 0 ? adresses[0].adresse : "";
        const code_postal = adresses.length > 0 ? adresses[0].code_postal : "";
        const ville = adresses.length > 0 ? adresses[0].ville : "";

        return {
            id: `extrabat-${client.id}`, extrabat_id: client.id,
            nom: client.nom || "", prenom: client.prenom || "",
            email: client.email || "", telephone, adresse, code_postal, ville,
            telephones: telephones.length > 1 ? telephones : undefined,
            adresses: adresses.length > 1 ? adresses : undefined,
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

// Full name mapping for suivi_par (must match CRM's extrabat_utilisateurs.nom)
const EXTRABAT_FULL_NAMES: Record<string, string> = {
    "quentin": "Quentin BRUNEAU", "paul": "Paul PICARD", "cindy": "Cindy BRUNEAU",
    "téo": "Téo BRIERE", "teo": "Téo BRIERE", "hugo": "Hugo COSTES",
};

function normalizeSuiviPar(name?: string): string {
    if (!name) return "Quentin BRUNEAU";
    // If already a full name, return as is
    if (name.includes(" ") && name !== name.toLowerCase()) return name;
    const clean = name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    for (const [key, fullName] of Object.entries(EXTRABAT_FULL_NAMES)) {
        const cleanKey = key.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        if (clean.includes(cleanKey)) return fullName;
    }
    return "Quentin BRUNEAU"; // Fallback
}

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

            // Enrich with contacts and sites count for Supabase clients
            const clientIds = (data || []).map((c: any) => c.id);
            let contactsMap: Record<string, number> = {};
            let sitesMap: Record<string, number> = {};
            let contractsMap: Record<string, number> = {};
            if (clientIds.length > 0) {
                const [contactsRes, sitesRes, contractsRes] = await Promise.all([
                    db.from("client_contacts").select("client_id").in("client_id", clientIds),
                    db.from("client_sites").select("client_id").in("client_id", clientIds),
                    db.from("maintenance_contracts").select("client_id").in("client_id", clientIds).eq("status", "actif"),
                ]);
                for (const c of contactsRes.data || []) contactsMap[c.client_id] = (contactsMap[c.client_id] || 0) + 1;
                for (const s of sitesRes.data || []) sitesMap[s.client_id] = (sitesMap[s.client_id] || 0) + 1;
                for (const m of contractsRes.data || []) contractsMap[m.client_id] = (contractsMap[m.client_id] || 0) + 1;
            }

            const supabaseClients = (data || []).map((c: any) => ({
                ...c, source: "supabase",
                contacts_count: contactsMap[c.id] || 0,
                sites_count: sitesMap[c.id] || 0,
                maintenance_contracts_count: contractsMap[c.id] || 0,
            }));

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
                .select("id, devis_number, titre_affaire, status, totaux, created_at, accepted_status, devis_type, client_id, client, clients:client_id(nom, prenom)")
                .order("created_at", { ascending: false })
                .limit(args.limit || 20);

            if (args.status) {
                // Handle status aliases
                const statusMap: Record<string, string[]> = {
                    "brouillon": ["brouillon", "draft"],
                    "draft": ["brouillon", "draft"],
                    "envoye": ["envoye", "sent"],
                    "sent": ["envoye", "sent"],
                    "accepte": ["accepte", "signed"],
                    "signed": ["accepte", "signed"],
                };
                const statusValues = statusMap[args.status.toLowerCase()] || [args.status];
                query = query.in("status", statusValues);
            }

            const dateFilter = getDateFilter(args.period);
            if (dateFilter) query = query.gte("created_at", dateFilter.toISOString());

            const { data, error } = await query;
            if (error) return { error: error.message };

            let results = (data || []).map((d: any) => {
                // Get client name from FK join or from JSONB client field
                const clientName = d.clients
                    ? `${d.clients.nom || ""} ${d.clients.prenom || ""}`.trim()
                    : (d.client?.nom ? `${d.client.nom} ${d.client.prenom || ""}`.trim() : "Inconnu");
                return {
                    id: d.id,
                    devis_number: d.devis_number,
                    titre_affaire: d.titre_affaire,
                    status: d.status,
                    accepted_status: d.accepted_status,
                    devis_type: d.devis_type,
                    client_name: clientName,
                    montant_ht: d.totaux?.ht || null,
                    montant_ttc: d.totaux?.ttc || d.totaux?.totalTTC || d.totaux?.total_ttc || null,
                    acompte: d.totaux?.acompte || null,
                    created_at: d.created_at,
                };
            });

            // Filter by client name search if provided
            if (args.search) {
                const searchLower = args.search.toLowerCase();
                results = results.filter((d: any) =>
                    d.client_name?.toLowerCase().includes(searchLower)
                );
            }

            return { devis: results, count: results.length };
        }

        // ===== SEARCH DEVIS =====
        case "search_devis": {
            const searchQuery = args.query || "";
            const words = searchQuery.split(/\s+/).filter((w: string) => w.length > 1);

            // Search in JSONB client field (client->>'nom') and also via client_id FK
            const { data: allDevis, error: searchError } = await db.from("devis")
                .select("id, devis_number, titre_affaire, status, totaux, created_at, accepted_status, devis_type, client_id, client, public_token, clients:client_id(nom, prenom)")
                .order("created_at", { ascending: false })
                .limit(50);

            if (searchError) return { error: searchError.message };

            // Filter by client name (search in JSONB client.nom AND FK client.nom)
            const filtered = (allDevis || []).filter((d: any) => {
                const jsonbNom = (d.client?.nom || "").toLowerCase();
                const jsonbPrenom = (d.client?.prenom || "").toLowerCase();
                const fkNom = (d.clients?.nom || "").toLowerCase();
                const fkPrenom = (d.clients?.prenom || "").toLowerCase();
                const titreAffaire = (d.titre_affaire || "").toLowerCase();
                const allText = `${jsonbNom} ${jsonbPrenom} ${fkNom} ${fkPrenom} ${titreAffaire}`;
                return words.every((w: string) => allText.includes(w.toLowerCase()));
            });

            const results = filtered.map((d: any) => {
                const clientName = d.clients
                    ? `${d.clients.nom || ""} ${d.clients.prenom || ""}`.trim()
                    : (d.client?.nom ? `${d.client.nom} ${d.client.prenom || ""}`.trim() : "Inconnu");
                return {
                    id: d.id,
                    devis_number: d.devis_number,
                    titre_affaire: d.titre_affaire,
                    status: d.status,
                    accepted_status: d.accepted_status,
                    devis_type: d.devis_type,
                    client_name: clientName,
                    client_email: d.client?.email || null,
                    client_telephone: d.client?.telephone || null,
                    client_adresse: d.client?.adresse || null,
                    montant_ht: d.totaux?.ht || null,
                    montant_ttc: d.totaux?.ttc || null,
                    acompte: d.totaux?.acompte || null,
                    created_at: d.created_at,
                    nb_lignes: d.client ? (Array.isArray(JSON.parse(JSON.stringify(d)).lignes) ? JSON.parse(JSON.stringify(d)).lignes?.length : 0) : 0,
                };
            }).slice(0, 10);

            return { devis: results, count: results.length, query: searchQuery };
        }

        // ===== GET DEVIS DETAILS =====
        case "get_devis_details": {
            const { data: devisData, error: devisError } = await db.from("devis")
                .select("id, devis_number, titre_affaire, status, client, lignes, totaux, taux_tva, observations, intro_text, options, selected_options, custom_quantities, accepted_status, accepted_at, devis_type, public_token, created_at, updated_at, client_id, clients:client_id(nom, prenom, email, telephone, adresse, code_postal, ville)")
                .eq("id", args.devis_id)
                .single();

            if (devisError) return { error: devisError.message };
            if (!devisData) return { error: "Devis non trouvé" };

            // Build client info from FK or JSONB
            const clientInfo = devisData.clients
                ? {
                    nom: `${devisData.clients.nom || ""} ${devisData.clients.prenom || ""}`.trim(),
                    email: devisData.clients.email,
                    telephone: devisData.clients.telephone,
                    adresse: `${devisData.clients.adresse || ""} ${devisData.clients.code_postal || ""} ${devisData.clients.ville || ""}`.trim(),
                }
                : devisData.client || {};

            // Format line items (products)
            const lignes = (devisData.lignes || []).map((l: any) => ({
                nom: l.name,
                reference: l.reference,
                description: l.description,
                quantite: l.quantity,
                prix_unitaire_ht: l.price_ht,
                total_ht: l.total_ht,
                total_ttc: l.total_ttc,
                tva: l.vat_rate ? `${l.vat_rate}%` : null,
            }));

            return {
                id: devisData.id,
                devis_number: devisData.devis_number,
                titre_affaire: devisData.titre_affaire,
                devis_type: devisData.devis_type,
                status: devisData.status,
                accepted_status: devisData.accepted_status,
                accepted_at: devisData.accepted_at,
                client: clientInfo,
                lignes: lignes,
                nb_articles: lignes.length,
                totaux: {
                    ht: devisData.totaux?.ht,
                    tva: devisData.totaux?.tva,
                    ttc: devisData.totaux?.ttc,
                    acompte: devisData.totaux?.acompte,
                },
                taux_tva: devisData.taux_tva,
                observations: devisData.observations,
                intro_text: devisData.intro_text,
                options: devisData.options,
                selected_options: devisData.selected_options,
                created_at: devisData.created_at,
                updated_at: devisData.updated_at,
            };
        }

        // ===== GET CLIENT HISTORY =====
        case "get_client_history": {
            // First get client name for fallback search
            const { data: histClient } = await db.from("clients").select("nom").eq("id", args.client_id).single();
            const clientNom = histClient?.nom || "";

            // Search by client_id UUID first
            const [savRes, oppRes, maintRes] = await Promise.all([
                db.from("sav_requests").select("id, client_name, system_type, problem_desc, status, urgent, requested_at").eq("client_id", args.client_id).order("requested_at", { ascending: false }).limit(10),
                db.from("opportunites").select("id, titre, statut, montant_estime, suivi_par, date_creation, statut_final").eq("client_id", args.client_id).order("date_creation", { ascending: false }).limit(10),
                db.from("maintenance_contracts").select("id, client_name, system_type, status, address, annual_amount").eq("client_id", args.client_id).limit(10),
            ]);

            let savData = savRes.data || [];
            let maintData = maintRes.data || [];

            // Fallback: if no results by client_id, search by client_name
            if (clientNom && savData.length === 0) {
                const { data: savByName } = await db.from("sav_requests")
                    .select("id, client_name, system_type, problem_desc, status, urgent, requested_at")
                    .ilike("client_name", `%${clientNom}%`)
                    .order("requested_at", { ascending: false }).limit(10);
                savData = savByName || [];
            }
            if (clientNom && maintData.length === 0) {
                const { data: maintByName } = await db.from("maintenance_contracts")
                    .select("id, client_name, system_type, status, address, annual_amount")
                    .ilike("client_name", `%${clientNom}%`).limit(10);
                maintData = maintByName || [];
            }

            return {
                sav_requests: savData, sav_count: savData.length,
                opportunites: oppRes.data || [], opp_count: (oppRes.data || []).length,
                maintenance_contracts: maintData, maint_count: maintData.length,
            };
        }

        // ===== GET CLIENT DETAILS (FULL) =====
        case "get_client_details": {
            // Fetch client base info
            const { data: clientData, error: clientError } = await db.from("clients")
                .select("id, nom, prenom, email, telephone, adresse, code_postal, ville, civilite, entreprise, client_type, source, actif, extrabat_id, siret, activite, origine_contact, suivi_par")
                .eq("id", args.client_id)
                .single();
            if (clientError) return { error: clientError.message };
            if (!clientData) return { error: "Client non trouvé" };

            const detailClientNom = (clientData as any).nom || "";

            // Fetch contacts, sites, opportunities, devis, call_notes by client_id (these are always linked properly)
            const [contactsRes, sitesRes, oppRes2, devisRes, callNotesRes] = await Promise.all([
                db.from("client_contacts").select("id, nom, prenom, telephone, email, fonction, principal").eq("client_id", args.client_id).order("principal", { ascending: false }),
                db.from("client_sites").select("id, label, adresse, code_postal, ville, system_type, system_brand, system_model, battery_installation_year, principal").eq("client_id", args.client_id).order("principal", { ascending: false }),
                db.from("opportunites").select("id, titre, description, statut, suivi_par, montant_estime, date_creation, statut_final").eq("client_id", args.client_id).order("date_creation", { ascending: false }).limit(10),
                db.from("devis").select("id, devis_number, titre_affaire, status, totaux, created_at").eq("client_id", args.client_id).order("created_at", { ascending: false }).limit(10),
                db.from("call_notes").select("id, call_subject, notes, is_completed, priority, created_at").eq("client_id", args.client_id).order("created_at", { ascending: false }).limit(10),
            ]);

            // For SAV and maintenance, search by BOTH client_id AND client_name (fallback for unlinked records)
            let savData2: any[] = [];
            let maintData2: any[] = [];

            // Try by client_id first
            const [savById, maintById] = await Promise.all([
                db.from("sav_requests").select("id, client_name, site, address, system_type, system_brand, problem_desc, status, urgent, requested_at, resolved_at").eq("client_id", args.client_id).order("requested_at", { ascending: false }).limit(15),
                db.from("maintenance_contracts").select("id, client_name, site, address, city_derived, system_type, system_brand, system_model, status, annual_amount, billing_mode, invoice_sent, invoice_paid, battery_installation_year").eq("client_id", args.client_id).order("created_at", { ascending: false }).limit(20),
            ]);

            savData2 = savById.data || [];
            maintData2 = maintById.data || [];

            // Fallback: also search by client_name containing the client's nom
            if (detailClientNom) {
                const existingSavIds = new Set(savData2.map((s: any) => s.id));
                const existingMaintIds = new Set(maintData2.map((m: any) => m.id));

                const [savByName, maintByName] = await Promise.all([
                    db.from("sav_requests").select("id, client_name, site, address, system_type, system_brand, problem_desc, status, urgent, requested_at, resolved_at")
                        .ilike("client_name", `%${detailClientNom}%`)
                        .order("requested_at", { ascending: false }).limit(20),
                    db.from("maintenance_contracts").select("id, client_name, site, address, city_derived, system_type, system_brand, system_model, status, annual_amount, billing_mode, invoice_sent, invoice_paid, battery_installation_year")
                        .ilike("client_name", `%${detailClientNom}%`)
                        .order("created_at", { ascending: false }).limit(30),
                ]);

                // Merge results, avoiding duplicates
                for (const s of (savByName.data || [])) {
                    if (!existingSavIds.has(s.id)) { savData2.push(s); existingSavIds.add(s.id); }
                }
                for (const m of (maintByName.data || [])) {
                    if (!existingMaintIds.has(m.id)) { maintData2.push(m); existingMaintIds.add(m.id); }
                }
            }

            return {
                client: { ...clientData, source: "supabase" },
                contacts: contactsRes.data || [],
                contacts_count: (contactsRes.data || []).length,
                sites: sitesRes.data || [],
                sites_count: (sitesRes.data || []).length,
                sav_requests: savData2,
                sav_count: savData2.length,
                opportunites: oppRes2.data || [],
                opp_count: (oppRes2.data || []).length,
                maintenance_contracts: maintData2,
                maint_count: maintData2.length,
                devis: devisRes.data || [],
                devis_count: (devisRes.data || []).length,
                call_notes: callNotesRes.data || [],
                call_notes_count: (callNotesRes.data || []).length,
            };
        }

        // ===== CHECK STOCK (load all, score, filter) =====
        case "check_stock": {
            // Common product synonyms for natural language → product name mapping
            const synonyms: Record<string, string[]> = {
                "telecommande": ["spacecontrol", "button", "doublebutton"],
                "télécommande": ["spacecontrol", "button", "doublebutton"],
                "telecommandes": ["spacecontrol", "button", "doublebutton"],
                "télécommandes": ["spacecontrol", "button", "doublebutton"],
                "centrale": ["hub", "hub2", "hub2+"],
                "centrales": ["hub", "hub2", "hub2+"],
                "detecteur": ["motioncam", "motionprotect", "doorprotect", "combiprotect"],
                "détecteur": ["motioncam", "motionprotect", "doorprotect", "combiprotect"],
                "detecteurs": ["motioncam", "motionprotect", "doorprotect", "combiprotect"],
                "détecteurs": ["motioncam", "motionprotect", "doorprotect", "combiprotect"],
                "sirene": ["streetsiren", "homesiren"],
                "sirène": ["streetsiren", "homesiren"],
                "sirenes": ["streetsiren", "homesiren"],
                "sirènes": ["streetsiren", "homesiren"],
                "clavier": ["keypad"],
                "claviers": ["keypad"],
                "fuite": ["leaksprotect", "leak"],
                "inondation": ["leaksprotect", "leak"],
                "fumee": ["fireprotect"],
                "fumée": ["fireprotect"],
                "incendie": ["fireprotect"],
                "camera": ["turretcam", "bulletcam"],
                "caméra": ["turretcam", "bulletcam"],
                "cameras": ["turretcam", "bulletcam"],
                "caméras": ["turretcam", "bulletcam"],
                "relais": ["relay", "multirelay", "wallswitch"],
                "transmetteur": ["multitransmitter", "transmitter"],
            };

            const rawTerms = args.query.split(/\s+/).filter((w: string) => w.length > 1);
            // Expand synonyms
            const searchTerms: string[] = [];
            for (const t of rawTerms) {
                searchTerms.push(t);
                const lower = t.toLowerCase();
                if (synonyms[lower]) {
                    searchTerms.push(...synonyms[lower]);
                }
            }

            // Load ALL stock products with subcategory/category info (< 300 products total)
            const { data: allProducts, error } = await db.from("stock_products")
                .select("id, name, code_article, marque, fournisseur, depot_quantity, min_quantity, paul_truck_quantity, quentin_truck_quantity, stock_subcategories(name, stock_categories(name))")
                .limit(500);

            if (error) return { error: error.message };

            // Build search groups: each original term + its synonyms form one group
            const searchGroups: string[][] = [];
            for (const t of rawTerms) {
                const lower = t.toLowerCase();
                const group = [lower];
                if (synonyms[lower]) group.push(...synonyms[lower]);
                searchGroups.push(group);
            }

            // Score each product: how many search GROUPS match (at least one term per group)
            const scored = (allProducts || []).map((p: any) => {
                const subcat = p.stock_subcategories?.name || "";
                const cat = p.stock_subcategories?.stock_categories?.name || "";
                const searchable = `${p.name} ${p.marque} ${p.fournisseur} ${p.code_article} ${subcat} ${cat}`.toLowerCase();
                const matchCount = searchGroups.filter(group =>
                    group.some(term => searchable.includes(term))
                ).length;
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

            // Sort by score desc (products matching ALL groups first)
            scored.sort((a: any, b: any) => b._score - a._score);

            // Prefer products matching ALL search groups; fallback to partial matches
            const totalGroups = searchGroups.length;
            const maxScore = scored.length > 0 ? scored[0]._score : 0;
            const topResults = maxScore === totalGroups
                ? scored.filter((r: any) => r._score === totalGroups).slice(0, 20)
                : scored.slice(0, 20);

            return { products: topResults, count: topResults.length, search_terms: rawTerms };
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
            const productName = args?.product_name;
            const location = args?.location || "depot";
            const quantityChange = parseInt(args?.quantity_change);
            const comment = args?.comment || "Modification via agent";

            if (!productId && !productName) return { error: "product_id ou product_name requis" };
            if (isNaN(quantityChange) || quantityChange === 0) return { error: "quantity_change invalide (doit être un nombre non nul)" };

            // Map location to column name
            const columnMap: Record<string, string> = {
                depot: "depot_quantity",
                paul_truck: "paul_truck_quantity",
                quentin_truck: "quentin_truck_quantity",
            };
            const column = columnMap[location];
            if (!column) return { error: `Emplacement invalide: ${location}. Utiliser: depot, paul_truck, quentin_truck` };

            // Get current product — try by ID first, fallback to name search
            let product: any = null;
            if (productId) {
                const { data, error: fetchError } = await db
                    .from("stock_products")
                    .select("id, name, depot_quantity, paul_truck_quantity, quentin_truck_quantity")
                    .eq("id", productId)
                    .single();
                if (!fetchError && data) product = data;
            }

            // Fallback: search by exact name (case-insensitive)
            if (!product && productName) {
                console.log(`Product ID lookup failed, falling back to name search: "${productName}"`);
                const { data } = await db
                    .from("stock_products")
                    .select("id, name, depot_quantity, paul_truck_quantity, quentin_truck_quantity")
                    .ilike("name", productName);
                if (data && data.length === 1) {
                    product = data[0];
                } else if (data && data.length > 1) {
                    // Try exact match first
                    const exact = data.find((p: any) => p.name.toLowerCase() === productName.toLowerCase());
                    product = exact || data[0];
                }
            }

            if (!product) return { error: `Produit non trouvé (ID: ${productId}, nom: ${productName})` };

            const currentQty = (product as any)[column] || 0;
            const newQty = currentQty + quantityChange;
            if (newQty < 0) return { error: `Quantité insuffisante. Stock actuel ${location}: ${currentQty}, modification demandée: ${quantityChange}` };

            // Update quantity
            const { error: updateError } = await db
                .from("stock_products")
                .update({ [column]: newQty })
                .eq("id", (product as any).id);
            if (updateError) return { error: updateError.message };

            // Insert movement record
            const movementType = quantityChange > 0 ? "entrée" : "sortie";
            await db.from("stock_movements").insert({
                stock_product_id: (product as any).id,
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
            const normalizedSuiviPar = normalizeSuiviPar(args.suivi_par);
            const oppInsertData: any = {
                titre: args.titre, description: args.description || "",
                montant_estime: args.montant_estime || null,
                suivi_par: normalizedSuiviPar, statut: "a-contacter",
            };
            if (validOppClientId) {
                oppInsertData.client_id = validOppClientId;
                // Enrich client data from Extrabat if missing in Supabase
                try {
                    const { data: clientData } = await db.from("clients").select("telephone, adresse, extrabat_id").eq("id", validOppClientId).single();
                    if (clientData && (!clientData.telephone || !clientData.adresse) && clientData.extrabat_id) {
                        console.log("Enriching client data from Extrabat, extrabat_id:", clientData.extrabat_id);
                        const extrabatData = await searchExtrabat(args.client_name || "");
                        const matchingClient = extrabatData.find((c: any) => c.extrabat_id === clientData.extrabat_id);
                        if (matchingClient) {
                            const updateFields: any = {};
                            if (!clientData.telephone && matchingClient.telephone) updateFields.telephone = matchingClient.telephone;
                            if (!clientData.adresse && matchingClient.adresse) {
                                updateFields.adresse = matchingClient.adresse;
                                if (matchingClient.code_postal) updateFields.code_postal = matchingClient.code_postal;
                                if (matchingClient.ville) updateFields.ville = matchingClient.ville;
                            }
                            if (Object.keys(updateFields).length > 0) {
                                console.log("Updating client with Extrabat data:", updateFields);
                                await db.from("clients").update(updateFields).eq("id", validOppClientId);
                            }
                        }
                    }
                } catch (enrichError) {
                    console.error("Error enriching client data:", enrichError);
                }
            } else if (args.client_name) {
                oppInsertData.commentaires = `Client: ${args.client_name} (non importé dans Supabase)`;
            }

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
            let details: any = {};
            if (typeof args.details === "object" && args.details !== null && !Array.isArray(args.details)) {
                details = args.details;
            } else if (typeof args.details === "string") {
                try { details = JSON.parse(args.details); } catch { details = {}; }
            }
            return { _hitl: true, type: "confirm", message: args.message, details, pendingAction: args.action_type };
        }

        case "ask_user_selection": {
            let options: any[] = [];
            if (Array.isArray(args.options)) {
                options = args.options;
            } else if (typeof args.options === "string") {
                try { options = JSON.parse(args.options); } catch (e) {
                    console.error("ask_user_selection: Failed to parse options string:", args.options, e);
                    options = [];
                }
            } else if (typeof args.options === "object" && args.options !== null) {
                // Gemini might send it as an object with numeric keys
                options = Object.values(args.options);
            }
            console.log("ask_user_selection: parsed options count =", options.length, "raw type =", typeof args.options, "isArray =", Array.isArray(args.options));
            return { _hitl: true, type: "select", message: args.message, options, pendingAction: "select" };
        }

        // ===== COMPOSE SMS =====
        case "compose_sms": {
            const recipientName = args.recipient_name || "";
            const smsBody = args.body || "";

            // Split recipient name into words for better matching (same as search_client)
            const smsWords = recipientName.split(/\s+/).filter((w: string) => w.length > 1);
            const smsSearchTerms = smsWords.length > 0 ? smsWords : [recipientName];

            // Search in team members first (try each word)
            let teamUsers: any[] = [];
            for (const term of smsSearchTerms) {
                const { data } = await db.from("users")
                    .select("display_name, phone, email, role")
                    .ilike("display_name", `%${term}%`);
                if (data && data.length > 0) {
                    teamUsers = data;
                    break;
                }
            }

            if (teamUsers.length === 1 && teamUsers[0].phone) {
                return {
                    _hitl: true,
                    type: "compose_sms",
                    message: `SMS prêt pour ${teamUsers[0].display_name}`,
                    recipientName: teamUsers[0].display_name,
                    recipientContact: teamUsers[0].phone,
                    recipientRole: teamUsers[0].role || "équipe",
                    body: smsBody,
                };
            }

            // Search in clients — build OR conditions for each word
            const smsOrConditions = smsSearchTerms
                .map((term: string) => `nom.ilike.%${term}%,prenom.ilike.%${term}%,entreprise.ilike.%${term}%`)
                .join(",");

            const { data: clientResults } = await db.from("clients")
                .select("id, nom, prenom, telephone, email, client_type")
                .or(smsOrConditions)
                .eq("actif", true)
                .limit(10);

            // Also search client_contacts for additional phone numbers
            const clientIds = (clientResults || []).map((c: any) => c.id);
            let contactPhones: Record<string, { phone: string, name: string }> = {};
            if (clientIds.length > 0) {
                const { data: contacts } = await db.from("client_contacts")
                    .select("client_id, telephone, nom, prenom")
                    .in("client_id", clientIds);
                for (const contact of (contacts || [])) {
                    if (contact.telephone && !contactPhones[contact.client_id]) {
                        contactPhones[contact.client_id] = {
                            phone: contact.telephone,
                            name: `${contact.prenom || ""} ${contact.nom || ""}`.trim(),
                        };
                    }
                }
            }

            // Combine team members (with phone) + clients (with phone from clients or client_contacts)
            const allCandidates: any[] = [];
            if (teamUsers) {
                for (const u of teamUsers) {
                    if (u.phone) allCandidates.push({ name: u.display_name, contact: u.phone, role: u.role || "équipe", source: "équipe" });
                }
            }
            for (const c of (clientResults || [])) {
                const phone = c.telephone || contactPhones[c.id]?.phone;
                if (phone) {
                    const fullName = `${c.prenom || ""} ${c.nom || ""}`.trim();
                    allCandidates.push({ name: fullName || c.nom, contact: phone, role: c.client_type || "client", source: "client" });
                }
            }

            if (allCandidates.length === 0) {
                return { error: `Aucun destinataire trouvé avec un numéro de téléphone pour "${recipientName}". Vérifiez le nom ou ajoutez un numéro de téléphone.` };
            }

            if (allCandidates.length === 1) {
                return {
                    _hitl: true,
                    type: "compose_sms",
                    message: `SMS prêt pour ${allCandidates[0].name}`,
                    recipientName: allCandidates[0].name,
                    recipientContact: allCandidates[0].contact,
                    recipientRole: allCandidates[0].source,
                    body: smsBody,
                };
            }

            // Multiple candidates — ask user to select
            return {
                error: `Plusieurs destinataires trouvés pour "${recipientName}" : ${allCandidates.map((c: any) => `${c.name} (${c.source}: ${c.contact})`).join(", ")}. Utilise ask_user_selection pour clarifier.`,
                candidates: allCandidates,
            };
        }

        // ===== COMPOSE EMAIL =====
        case "compose_email": {
            const emailRecipientName = args.recipient_name || "";
            const emailSubject = args.subject || "";
            const emailBody = args.body || "";

            // Split recipient name into words for better matching
            const emailWords = emailRecipientName.split(/\s+/).filter((w: string) => w.length > 1);
            const emailSearchTerms = emailWords.length > 0 ? emailWords : [emailRecipientName];

            // Search in team members first (try each word)
            let emailTeamUsers: any[] = [];
            for (const term of emailSearchTerms) {
                const { data } = await db.from("users")
                    .select("display_name, phone, email, role")
                    .ilike("display_name", `%${term}%`);
                if (data && data.length > 0) {
                    emailTeamUsers = data;
                    break;
                }
            }

            if (emailTeamUsers.length === 1 && emailTeamUsers[0].email) {
                return {
                    _hitl: true,
                    type: "compose_email",
                    message: `Email prêt pour ${emailTeamUsers[0].display_name}`,
                    recipientName: emailTeamUsers[0].display_name,
                    recipientContact: emailTeamUsers[0].email,
                    recipientRole: emailTeamUsers[0].role || "équipe",
                    subject: emailSubject,
                    body: emailBody,
                };
            }

            // Search in clients — build OR conditions for each word
            const emailOrConditions = emailSearchTerms
                .map((term: string) => `nom.ilike.%${term}%,prenom.ilike.%${term}%,entreprise.ilike.%${term}%`)
                .join(",");

            const { data: emailClientResults } = await db.from("clients")
                .select("id, nom, prenom, email, telephone, client_type")
                .or(emailOrConditions)
                .eq("actif", true)
                .limit(10);

            // Also search client_contacts for additional emails
            const emailClientIds = (emailClientResults || []).map((c: any) => c.id);
            let contactEmails: Record<string, { email: string, name: string }> = {};
            if (emailClientIds.length > 0) {
                const { data: contacts } = await db.from("client_contacts")
                    .select("client_id, email, nom, prenom")
                    .in("client_id", emailClientIds);
                for (const contact of (contacts || [])) {
                    if (contact.email && !contactEmails[contact.client_id]) {
                        contactEmails[contact.client_id] = {
                            email: contact.email,
                            name: `${contact.prenom || ""} ${contact.nom || ""}`.trim(),
                        };
                    }
                }
            }

            // Combine
            const emailCandidates: any[] = [];
            if (emailTeamUsers) {
                for (const u of emailTeamUsers) {
                    if (u.email) emailCandidates.push({ name: u.display_name, contact: u.email, role: u.role || "équipe", source: "équipe" });
                }
            }
            for (const c of (emailClientResults || [])) {
                const email = c.email || contactEmails[c.id]?.email;
                if (email) {
                    const fullName = `${c.prenom || ""} ${c.nom || ""}`.trim();
                    emailCandidates.push({ name: fullName || c.nom, contact: email, role: c.client_type || "client", source: "client" });
                }
            }

            if (emailCandidates.length === 0) {
                return { error: `Aucun destinataire trouvé avec une adresse email pour "${emailRecipientName}". Vérifiez le nom ou ajoutez une adresse email.` };
            }

            if (emailCandidates.length === 1) {
                return {
                    _hitl: true,
                    type: "compose_email",
                    message: `Email prêt pour ${emailCandidates[0].name}`,
                    recipientName: emailCandidates[0].name,
                    recipientContact: emailCandidates[0].contact,
                    recipientRole: emailCandidates[0].source,
                    subject: emailSubject,
                    body: emailBody,
                };
            }

            // Multiple candidates — ask user to select
            return {
                error: `Plusieurs destinataires trouvés pour "${emailRecipientName}" : ${emailCandidates.map((c: any) => `${c.name} (${c.source}: ${c.contact})`).join(", ")}. Utilise ask_user_selection pour clarifier.`,
                candidates: emailCandidates,
            };
        }

        default:
            return { error: `Unknown tool: ${toolName}` };
    }
}

// --- Process Gemini response ---
async function processGeminiResponse(geminiResult: any, messages: any[], depth = 0): Promise<any> {
    if (depth > 5) return { type: "error", message: "Trop d'étapes. Reformulez votre demande." };

    const candidate = geminiResult?.candidates?.[0];
    const allParts = candidate?.content?.parts || [];

    // Filter to only actionable parts (text or functionCall), ignoring thought parts
    const actionableParts = allParts.filter((p: any) => p.text || p.functionCall);

    // If no actionable parts, retry
    if (actionableParts.length === 0) {
        const blockReason = candidate?.finishReason;
        const hasThoughts = allParts.some((p: any) => p.thought);
        console.error(`No actionable parts. finishReason=${blockReason}, hasThoughts=${hasThoughts}, totalParts=${allParts.length}`);
        console.error("Raw response (truncated):", JSON.stringify(geminiResult).substring(0, 500));

        // Retry on STOP with no actionable content (thinking mode or intermittent issue)
        if (depth < 2) {
            console.log(`Retrying (attempt ${depth + 1})...`);
            try {
                const retryResult = await callGemini(messages, TOOLS);
                return processGeminiResponse(retryResult, messages, depth + 1);
            } catch (e) {
                console.error("Retry failed:", e);
            }
        }

        return { type: "error", message: `Réponse inattendue du modèle. ${blockReason ? `(${blockReason})` : 'Réessayez.'}` };
    }

    const functionCalls = actionableParts.filter((p: any) => p.functionCall);
    const textParts = actionableParts.filter((p: any) => p.text);

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
    let stockProducts: any[] | null = null;

    for (const part of functionCalls) {
        const { name, args } = part.functionCall;
        const result = await executeTool(name, args || {});
        if (result?._hitl) { delete result._hitl; hitlResult = result; continue; }

        // Capture stock products data for frontend rendering
        if (name === "check_stock" && result?.products) {
            stockProducts = result.products;
        }

        modelParts.push({ functionCall: { name, args: args || {} } });
        responseParts.push({ functionResponse: { name, response: result } });
    }

    if (hitlResult) return hitlResult;

    if (modelParts.length > 0) {
        messages.push({ role: "model", parts: modelParts });
        messages.push({ role: "user", parts: responseParts });
        try {
            const followUp = await callGemini(messages, TOOLS);
            const result = await processGeminiResponse(followUp, messages, depth + 1);
            // Attach stock products to the response if available
            if (stockProducts && result.type !== "error") {
                result.stockProducts = stockProducts;
            }
            return result;
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
                    montant_estime: details.montant_estime || null, suivi_par: normalizeSuiviPar(details.suivi_par),
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

            // Direct stock update
            if (pending.includes("stock") && (details.product_id || details.product_name)) {
                const result = await executeTool("update_stock_quantity", {
                    product_id: details.product_id,
                    product_name: details.product_name,
                    location: details.location || "depot",
                    quantity_change: details.quantity_change,
                    comment: details.comment || "Modification via agent",
                });
                if (result?.success) return { type: "success", message: result.message };
                return { type: "error", message: `Erreur modification stock : ${result?.error || "inconnue"}` };
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
