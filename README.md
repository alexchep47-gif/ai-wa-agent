# AI WA Agent

Agent IA WhatsApp **gratuit** — sans préfixe, prompt configurable, déploiement Render.

## Variables d'environnement (.env / Render)

| Variable | Obligatoire | Description |
|----------|-------------|-------------|
| `GEMINI_API_KEY` | Oui | Clé gratuite [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| `OWNER_NUMBER` | Oui | Ton numéro WhatsApp sans `+` (ex: `2376XXXXXXXX`) |
| `SYSTEM_PROMPT` | Recommandé | Rôle de l'agent **avant** la première utilisation |
| `BOT_NAME` | Non | Nom du bot (défaut: CMR AI Agent) |
| `PORT` | Non | Laissé à Render |

Sur **Render**, tu ne crées pas de fichier `.env` : tu ajoutes chaque variable dans **Environment**.

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
- Plan Free Render : le service s'endort après inactivité ; au réveil, la session peut se perdre et il faudra parfois **re-pairer**.
- Les messages de **groupe** sont ignorés par défaut.
- Ne partage jamais ta `GEMINI_API_KEY`.
