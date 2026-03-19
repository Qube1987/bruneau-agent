---
name: extrabat-api
description: Documentation complète de l'API Extrabat v5.0.1 pour les applications Bruneau Protection. Utiliser cette skill dès qu'une tâche implique l'API Extrabat : appels REST, création de devis, gestion clients, SAV, agenda, articles, pièces commerciales, paramètres boutique, ou tout code d'intégration avec Extrabat. Toujours consulter avant d'écrire du code qui touche à Extrabat.
---

# API Extrabat v5.0.1 — Documentation Bruneau Protection

## Authentification

Deux méthodes disponibles :

**Bearer Token (JWT)**
```
Authorization: Bearer <token>
```

**API Key (Header)**
```
X-EXTRABAT-API-KEY: <clé utilisateur>
X-EXTRABAT-SECURITY: <SHA-256(apiKey + clientSecret)>
```

## Limites & Bonnes pratiques

- **25 appels/seconde** max, **10 000 appels/24h** max → retourne `429` si dépassé
- Pagination max : **100 items par appel** (headers `X-Pagination-*`)
- Paramètres de pagination communs : `?page=1&nbitem=100`
- Paramètre `?magasin=<id>` pour filtrer par boutique
- Paramètre `?include=champ1,champ2` pour enrichir les réponses
- Filtres : `?filter=champ~/regex/` et `?notFilter=champ~/regex/`
- Éviter les appels parallèles, préférer les séquentiels
- Réduire les `include` au strict nécessaire

## Headers de pagination dans les réponses

```
X-Pagination-Limit        → items par page
X-Pagination-Current-Page → page courante
X-Pagination-Total-Pages  → nb total de pages
X-Total-Count             → nb total d'items
```

---

## Endpoints par catégorie

### 🧑 Client

| Méthode | Endpoint | Description |
|---------|----------|-------------|
| POST | `/v1/client` | Créer un client |
| GET | `/v2/clients` | Lister les clients du magasin |
| GET | `/v3/client/{client}` | Détail d'un client (v3) |
| POST | `/v1/client/{client}/action` | Créer une action client |
| POST | `/v1/client/{client}/devis` | Créer un devis pour un client |

**Includes disponibles pour `/v3/client/{client}` :**
`telephone`, `adresse`, `rdvsClient`, `rdv.users`, `regroupement`, `piece`, `reglement`, `statut`, `couleur`, `origine`, `client.reponseQuestionComplementaire`, `ouvrage`, `ouvrage.reponseQuestionComplementaire`, `ouvrage.ouvrage_metier`, `ouvrage.ouvrage_metier.article`, `ouvrage.taches`, `ouvrage.taches.article`, `ouvrage.taches.rdv`, `ouvrage.services`, `ouvrage.services.article`, `ouvrage.services.rdv`, `ouvrage.sav`, `ouvrage.sav.rdv`

**Includes disponibles pour `/v2/clients` :**
`telephone`, `adresse`, `rdvsClient`, `regroupement`, `piece`, `reglement`, `statut`, `couleur`, `origine`, `client.reponseQuestionComplementaire`, `ouvrage` (et sous-includes ouvrage)

**Filtres `/v2/clients` :**
- `?filter=client.codeCompta~/411/`
- `?updated=23-06-2021..25-06-2021`
- `?client.createdAt=23-06-2021T12:00:00..25-06-2021T15:20:00`
- `?q=<recherche>`

**Création client** — récupérer d'abord les IDs via :
- `/v1/utilisateurs` (suiviPar)
- `/v1/parametres/civilites`
- `/v1/parametres/origines-contact`
- `/v1/parametres/questions-complementaires`
- `/v1/parametres/regroupements`
- `/v1/parametres/client-statuts`
- `/v1/parametres/type-adresse`
- `/v1/parametres/type-telephone`

Option anti-doublon : `?forbidden_duplicate=true`

---

### 📄 Gestion commerciale (Pièces / Devis)

| Méthode | Endpoint | Description |
|---------|----------|-------------|
| POST | `/v1/client/{client}/devis` | Créer un devis |
| GET | `/v1/pieces` | Lister les pièces |
| GET | `/v1/piece/{piece}` | Détail d'une pièce |

**⚠️ IMPORTANT pour la création de devis :**
Les montants HT/TTC/TVA de la pièce **ET** de chaque ligne doivent être calculés dans votre logiciel avant envoi à Extrabat.

**Types de documents (`type`) :**
```
1 = Devis
2 = Commande client
3 = Bon de livraison
4 = Facture client
5 = Avoir client
6 = Commande fournisseur
7 = Bon de réception
8 = Facture fournisseur
9 = Avoir fournisseur
```

**Champs requis pour créer un devis (PieceType) :**
`extrabatFrsId`, `type`, `code`, `date`, `titre`, `totalHT`, `totalTTC`, `totalTVA`, `escompte`, `portHT`, `portTTC`, `portTVA`, `blFrsNum`, `blFrsDate`, `adresseFacturation`, `adresseLivraison`, `client` (id), `lignes[]`

**Champs requis par ligne (LigneType) :**
`code`, `article` (id), `description`, `quantite`, `puht`, `totalHt`, `totalEscompte`, `totalNet`, `tauxTva`, `totalTva`, `totalTtc`, `ordre`, `tenueStock`, `prixMini`, `nomenclature`, `nomenclatureId`, `poids`, `numeroSousCommande`, `datePrevisionnelleSousCommande`, `canceled`, `quantiteEnfant`, `floatting`, `typeCommission`, `pourcentageCommission`, `userCommission`, `prixAchat`, `quantiteConditionnement`, `transformeEn`, `piece`, `tauxRemise`, `numLigne`

**Filtres `/v1/pieces` :**
- `?types=devis,commande,facture,...`
- `?date_debut=2019-02-20&date_fin=2019-02-25`
- `?clients=123456,789456`
- `?order=piece.date:desc`

**Includes `/v1/pieces` :**
`fournisseur`, `client`, `salesforce`, `telephone`, `adresse`, `regroupement`, `lignes`, `ligne.article`, `suivi-par`, `utilisateurs-associes`, `journal`, `compteAssocie`, `compteEcartNegatif`, `compteEcartPositif`, `tiers_payant`, `affaire`

---

### 📅 Agenda (RDV)

| Méthode | Endpoint | Description |
|---------|----------|-------------|
| POST | `/v1/agenda/rendez-vous` | Créer un RDV |
| GET | `/v1/agenda/rendez-vous/{rdv}` | Détail d'un RDV |
| POST | `/v1/agenda/rendez-vous/{rdv}` | Modifier un RDV |
| GET | `/v1/agenda/rendez-vous/{rdv}/signatures` | Télécharger signatures (multipart) |
| POST | `/v1/agenda/rendez-vous/{rdv}/sav` | Mettre à jour statut SAV du RDV |
| POST | `/v1/agenda/rendez-vous/{rdv}/service` | Mettre à jour statut Service du RDV |
| POST | `/v1/agenda/rendez-vous/{rdv}/tache` | Mettre à jour statut Tâche du RDV |
| POST | `/v3/task/meeting/{id}/lock` | Verrouiller un RDV tâche |
| POST | `/v3/task/meeting/{id}/unlock` | Déverrouiller un RDV tâche |
| GET | `/v1/utilisateur/{user}/rendez-vous` | RDVs d'un utilisateur par plage de dates |
| GET | `/v1/rendez-vous` | RDVs de l'utilisateur connecté |

**Includes RDV :** `client`, `couleur`, `labels`, `user`, `sav.questions`, `service.questions.questions`

**Format date RDV :** `yyyy-MM-dd HH:mm`

---

### 🔧 SAV

| Méthode | Endpoint | Description |
|---------|----------|-------------|
| GET | `/v1/savs` | Lister les SAV |

**Filtres SAV :** `etat`, `rubrique`, `suivi_par`, `rdv_debut`, `rdv_fin`, `adresse`, `code_postal`, `ville`, `order`

**Tri SAV :** `sav.dateCreation`, `sav.observation`, `rubrique.libelle`, `savEtat.libelle`, `user.nom`, `rdv.debut`, `adresse.description`, `adresse.codePostal`, `adresse.ville`, `client.nom`, `client.prenom`

---

### ⚙️ Services

| Méthode | Endpoint | Description |
|---------|----------|-------------|
| GET | `/v1/services` | Lister les services |

Mêmes filtres et tris que SAV.

---

### 📦 Articles

| Méthode | Endpoint | Description |
|---------|----------|-------------|
| GET | `/v1/articles` | Lister les articles |
| GET | `/v1/article/{article}` | Détail article par ID |
| GET | `/v1/magasin/{magasin}/article/{code}` | Détail article par code |
| POST | `/v1/article/{article}/image` | Upload image article |
| DELETE | `/v1/article/{article}/image` | Supprimer image article |
| POST | `/v1/shop/{shop_id}/articles/batch` | Import batch CSV |
| POST | `/v1/article/from-file` | Mise à jour articles CSV |

**Includes articles :** `stock`, `article.image`, `article.supplier`

**Import CSV batch** — colonnes requises : `code`, `label`, `barCode`, `description`, `purchasePrice`, `price`, `minimalPrice`, `inventoryMaintaining`, `articleDeee`, `weight`, `recommandedPrice`, `note`, `subCategory`, `category` (id), `vatRate` (id), `unit` (id), `supplierArticle` (id), `accountingPlan` (id), `purchasingAccount` (id)
Encodage UTF-8, séparateur point-virgule.

---

### 👤 Utilisateurs

| Méthode | Endpoint | Description |
|---------|----------|-------------|
| GET | `/v1/utilisateurs` | Lister les utilisateurs |
| GET | `/v3/profile` | Profil de l'utilisateur connecté + magasins |

**Filtres utilisateurs :** `?actif=true/false/` (vide = tous)

**Includes `/v3/profile` :** `magasin.statut_sav`, `magasin.statut_service`, `magasin.modules`, `rights`

---

### 🏭 Fournisseurs

| Méthode | Endpoint | Description |
|---------|----------|-------------|
| GET | `/v1/fournisseurs` | Lister les fournisseurs |

**Includes :** `fournisseur` (adresse, email, téléphone, observation, franco, contact, emailCommande)

---

### 💼 Affaires (Business)

| Méthode | Endpoint | Description |
|---------|----------|-------------|
| GET | `/v1/affaires` | Lister les affaires d'une boutique |
| GET | `/v1/business` | Lister les business |
| GET | `/v1/business/{id}` | Détail d'un business |

**Includes affaires :** `client`, `origine`

---

### 🗂️ Bibliothèque

| Méthode | Endpoint | Description |
|---------|----------|-------------|
| GET | `/v1/bibliotheque/items` | Arborescence bibliothèque |
| GET | `/v1/bibliotheque/item/{id_item}` | Détail d'un item |
| POST | `/v1/bibliotheque/item/{itemParentId}/folder` | Créer un dossier |
| POST | `/v1/bibliotheque/item/{idItem}` | Modifier un item |
| DELETE | `/v1/bibliotheque/item/{idItem}` | Supprimer un item |
| POST | `/v1/bibliotheque/item/delete` | Supprimer une liste d'items |
| GET | `/v1/bibliotheque/item/{id_item}/download` | Télécharger un document |
| GET | `/v1/bibliotheque/item/{id_item}/thumbnail/download` | Télécharger thumbnail |
| POST | `/v1/bibliotheque/document` | Ajouter un document |
| POST | `/v1/bibliotheque/item/upload/{item}` | Ajouter un item |
| POST | `/v1/bibliotheque/item/move/{idItem}` | Déplacer des items |
| POST | `/v1/bibliotheque` | Action MOVE sur items |
| GET | `/v1/bibliotheque/dossiers` | Lister les dossiers |
| GET | `/v1/bibliotheque/documents/{dossier}/last` | Derniers docs d'un dossier |

**Format itemId :** `D<id>` pour dossier, `F<id>` pour fichier

---

### 📁 Porte-document client

| Méthode | Endpoint | Description |
|---------|----------|-------------|
| GET | `/v1/client/{client}/portedocument/items` | Arborescence porte-doc client |
| GET | `/v1/client/{client}/portedocument/item/{idItem}` | Détail item porte-doc |
| POST | `/v1/client/{client}/portedocument/item/{idItem}` | Modifier un item |
| DELETE | `/v1/client/{client}/portedocument/item/{idItem}` | Supprimer un item |
| POST | `/v1/client/{client}/portedocument/item/delete` | Supprimer une liste |
| GET | `/v1/client/{client}/portedocument/item/{idItem}/download` | Télécharger PDF |
| GET | `/v1/client/{client}/portedocument/item/{idItem}/thumbnail/download` | Thumbnail |
| POST | `/v1/client/{client}/portedoc` | Uploader un document |
| POST | `/v1/client/{client}/portedocument/document` | Ajouter document multipart |
| POST | `/v1/client/{client}/portedocument/item/upload/{item}` | Ajouter item |
| POST | `/v1/client/{client}/portedocument/item/move/{idItem}` | Déplacer items |
| POST | `/v1/client/{client}/portedocument/item/{itemParentId}/folder` | Créer dossier |
| GET | `/v1/client/{id}/portedoc/dossiers` | Lister dossiers client |
| GET | `/v1/client/{client}/portedoc/documents/{dossier}/last` | Derniers docs |
| POST | `/v1/porteDocument` | Action MOVE |

---

### ⚙️ Paramètres

| Méthode | Endpoint | Description |
|---------|----------|-------------|
| GET | `/v1/parametres/civilites` | Civilités |
| GET | `/v1/parametres/origines-contact` | Origines de contact |
| GET | `/v1/parametres/client-statuts` | Statuts client |
| GET | `/v1/parametres/type-adresse` | Types d'adresse |
| GET | `/v1/parametres/type-telephone` | Types de téléphone |
| GET | `/v1/parametres/regroupements` | Regroupements |
| GET | `/v1/parametres/questions-complementaires` | Questions complémentaires |
| GET | `/v2/parametres/action/types` | Types d'actions |
| GET | `/v1/shop/{shop_id}/parameters/units` | Unités de la boutique |
| GET | `/v1/shop/{shop_id}/parameters/accounting-plan` | Plan comptable |
| GET | `/v1/shop/{shop_id}/parameters/articles/categories` | Catégories articles |
| GET | `/v1/tva` | Taux de TVA |

---

## Codes d'erreur courants

| Code | Signification |
|------|--------------|
| 400 | Données mal formées |
| 403 | Accès refusé (droits insuffisants) |
| 404 | Ressource non trouvée |
| 406 | Type/statut inexistant |
| 409 | Doublon (email ou téléphone existant) |
| 417 | Erreur de format des données body |
| 422 | Erreur logique (action impossible) |
| 429 | Rate limit dépassé |
