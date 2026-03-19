# Schémas de données — API Extrabat

## Client (création — ClientCreateDTO)

```json
{
  "civilite": 1,           // requis — ID via /v1/parametres/civilites
  "status": 1,             // requis — ID via /v1/parametres/client-statuts
  "origine": 1,            // requis — ID via /v1/parametres/origines-contact
  "suiviPar": 1,           // ID user via /v1/utilisateurs
  "nom": "Dupont",
  "prenom": "Jean",
  "email": "jean@example.com",
  "observation": "",
  "emailing": true,
  "sms": true,
  "siret": "",
  "tvaIntra": "",
  "telephones": [
    { "typeId": 1, "number": "0612345678", "ordre": 1 }
  ],
  "adresses": [
    { "codePostal": "27000", "description": "1 rue de la paix", "ville": "Évreux", "typeId": 1 }
  ]
}
```

## Devis (création — PieceType)

```json
{
  "extrabatFrsId": "<magasin_id>",
  "type": 1,               // 1 = Devis
  "code": "DEV-2025-001",
  "date": "2025-01-15",
  "titre": "Installation alarme",
  "totalHT": 1000.00,      // ⚠️ calculer avant envoi
  "totalTTC": 1200.00,
  "totalTVA": 200.00,
  "escompte": 0,
  "portHT": 0,
  "portTTC": 0,
  "portTVA": 0,
  "blFrsNum": "",
  "blFrsDate": "",
  "adresseFacturation": "1 rue de la paix, 27000 Évreux",
  "adresseLivraison": "1 rue de la paix, 27000 Évreux",
  "client": 12345,
  "commentaire": "",
  "lignes": [
    {
      "code": "ART001",
      "article": 456,      // ID article Extrabat
      "description": "Centrale alarme Ajax Hub 2",
      "quantite": 1,
      "puht": 1000.00,
      "totalHt": 1000.00,
      "totalEscompte": 0,
      "totalNet": 1000.00,
      "tauxTva": 20,
      "totalTva": 200.00,
      "totalTtc": 1200.00,
      "ordre": 1,
      "tenueStock": false,
      "prixMini": 0,
      "nomenclature": false,
      "nomenclatureId": 0,
      "poids": 0,
      "numeroSousCommande": 0,
      "datePrevisionnelleSousCommande": null,
      "canceled": "",
      "quantiteEnfant": 0,
      "floatting": "",
      "typeCommission": 0,
      "pourcentageCommission": 0,
      "userCommission": 0,
      "prixAchat": 0,
      "quantiteConditionnement": 0,
      "transformeEn": 0,
      "piece": "",
      "tauxRemise": 0,
      "numLigne": 1
    }
  ]
}
```

## RDV (création/modification — RdvType)

```json
{
  "objet": "Intervention SAV",
  "observation": "Problème de détecteur",
  "debut": "2025-01-20 09:00",
  "fin": "2025-01-20 11:00",
  "journee": false,
  "isPrivate": false,
  "rue": "1 rue de la paix",
  "cp": "27000",
  "ville": "Évreux",
  "latitude": 49.024,
  "longitude": 1.151,
  "plannedTime": 2.0,
  "travelTime": 15,
  "couleur": 1,
  "rdvClients": [{ "client": 12345 }],
  "users": [{ "user": 1 }],
  "labels": [{ "type": 1 }],
  "eventNotification": true
}
```

## Article (schéma de retour)

```json
{
  "id": 456,
  "code": "ART001",
  "codeBarre": null,
  "libelle": "Centrale Ajax Hub 2",
  "description": null,
  "prix": "1000.00",
  "tenueStock": false,
  "prixMini": "0",
  "deee": "0",
  "poids": "0",
  "hasImage": false,
  "tauxTva": { "id": 1, "taux": "20.00" },
  "unite": { "id": 1, "libelle": "U" },
  "famille": { "id": 1, "libelle": "Alarme" }
}
```

## Pagination (paramètres query communs)

```
?page=1        → page courante (défaut: 1)
?nbitem=100    → items par page (défaut: 100, max: 100)
?magasin=<id>  → filtrer par boutique
```

## Statut SAV / Service (mise à jour)

```json
{ "statut": 2 }   // ID du statut à appliquer
```
