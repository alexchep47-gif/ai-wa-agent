# AI WA Agent

Agent IA WhatsApp **gratuit** — sans préfixe, prompt configurable, déploiement Render.

## Variables d'environnement (.env / Render)

| Variable | Obligatoire | Description |
|----------|-------------|-------------|
| `GEMINI_API_KEY` | Oui | Clé gratuite [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| `GEMINI_MODEL` | Non | Modèle primaire (défaut : `gemini-2.5-flash`) ; secours : Gemini 2.5 Flash puis 3.8 Flash, ensuite les modèles Flash Lite |
| `OWNER_NUMBER` | Oui | Ton numéro WhatsApp sans `+` (ex: `2376XXXXXXXX`) |
| `SYSTEM_PROMPT` | Recommandé | Rôle de l'agent **avant** la première utilisation |
| `BOT_NAME` | Non | Nom du bot (défaut: CMR AI Agent) |
| `PORT` | Non | Laissé à Render |

Sur **Render**, tu ne crées pas de fichier `.env` : tu ajoutes chaque variable dans **Environment**.
Si un modèle échoue, l’agent essaie le suivant dans cet ordre. Les modèles partagent le quota Gemini de ta clé/projet : un quota épuisé globalement peut bloquer toute la chaîne.

## Statut WhatsApp (administrateur)

Depuis le numéro configuré dans `ADMIN_NUMBER`, envoie au bot `statut: Ton texte ici` (ou `!statut Ton texte ici`) pour publier un statut texte. La commande est réservée à l’administrateur et limitée à 700 caractères. L’audience comprend les contacts WhatsApp qui ont déjà écrit au bot depuis son dernier démarrage ; elle n’est pas automatiquement élargie aux contacts inconnus. Baileys requiert une liste de JID destinataires pour publier un statut.

---

## Déploiement Render + connexion WhatsApp (iPhone)

### Étape 1 — Créer le service
1. Va sur [render.com](https://render.com) et connecte ton GitHub
2. **New +** → **Web Service**
3. Repo : `ai-wa-agent`
4. Runtime : **Docker**
5. Plan : **Free**

### Étape 2 — Variables d'environnement
Dans **Environment**, ajoute :

```
GEMINI_API_KEY = (ta clé Gemini)
OWNER_NUMBER   = 2376XXXXXXXX
SYSTEM_PROMPT  = Tu es un assistant éducatif camerounais...
BOT_NAME       = CMR AI Agent
```

Puis **Create Web Service** / **Deploy**.

### Étape 3 — Récupérer le code de pairing
1. Dans Render, ouvre ton service → onglet **Logs**
2. Attends le démarrage (1–2 min)
3. Cherche une ligne du type :
   ```
   🔑 CODE DE PAIRING : ABCD-EFGH
   ```
4. Note ce code (il expire assez vite)

### Étape 4 — Lier WhatsApp sur ton iPhone
1. Ouvre **WhatsApp**
2. Va dans **Réglages** → **Appareils connectés**
3. Appuie sur **Connecter un appareil**
4. En bas, choisis **Lier avec un numéro de téléphone** (pas le QR)
5. Entre le **code de pairing** affiché dans les Logs Render
6. Valide

Tu dois voir dans les Logs :
```
✅ CMR AI Agent connecté à WhatsApp !
```

### Étape 5 — Tester
Envoie un message **en privé** au numéro lié (ou depuis un autre téléphone vers le tien si le bot est sur ton compte) :

> Explique la photosynthèse

L'agent répond **sans préfixe**.

---

## Notes importantes

- `OWNER_NUMBER` doit être le **même numéro** que le compte WhatsApp que tu veux lier.
- La session WhatsApp est stockée dans les fichiers locaux `auth_info` (aucune base de données externe). Sur Render Free, le système de fichiers peut être éphémère : après un redémarrage ou un redéploiement, il faudra parfois **re-pairer**.
- Les messages de **groupe** sont ignorés par défaut.
- Ne partage jamais ta `GEMINI_API_KEY`.
