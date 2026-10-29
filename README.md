# AI WA Agent

Agent IA WhatsApp **gratuit** et simple à déployer sur **Render** (comme OVL).

## Fonctionnalités

- Connexion WhatsApp facile (code de pairing ou QR)
- Chat IA avec **Google Gemini** (gratuit)
- Commandes utiles : `.ai`, `.menu`, `.ping`, `.info`
- Réponses automatiques intelligentes
- Multi-tâches (texte, questions, aide éducative)
- Dockerfile prêt pour Render

## Déploiement sur Render (recommandé)

### 1. Crée un compte Render
Va sur [render.com](https://render.com) et connecte ton GitHub.

### 2. Nouveau Web Service
- Clique **New +** → **Web Service**
- Sélectionne le repo `ai-wa-agent`
- Configuration :
  - **Name** : `ai-wa-agent`
  - **Runtime** : Docker
  - **Instance Type** : Free

### 3. Variables d'environnement
Ajoute dans **Environment** :

| Clé | Valeur |
|-----|--------|
| `GEMINI_API_KEY` | Ta clé gratuite Gemini |
| `OWNER_NUMBER` | Ton numéro (ex: 2376XXXXXXXX) |
| `BOT_NAME` | CMR AI Agent |
| `PREFIX` | `.` |

### 4. Déploie
Clique **Create Web Service**.

### 5. Connecte WhatsApp
1. Ouvre les **Logs** de Render
2. Tu verras un **code de pairing** (ex: `ABCD-EFGH`)
3. Sur ton téléphone : WhatsApp → Appareils connectés → Connecter un appareil → **Lier avec un numéro de téléphone**
4. Entre le code

Le bot est connecté !

## Clé Gemini gratuite

1. Va sur [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
2. Crée une clé API
3. Colle-la dans `GEMINI_API_KEY`

## Commandes disponibles

| Commande | Description |
|----------|-------------|
| `.ai [question]` | Pose une question à l'IA |
| `.menu` | Affiche le menu |
| `.ping` | Teste si le bot répond |
| `.info` | Infos sur le bot |

Tu peux aussi écrire directement au bot (sans commande) pour discuter avec l'IA.

## Notes importantes

- Le plan **Free** de Render s'éteint après ~15 min d'inactivité. Le bot se reconnecte automatiquement au prochain message (parfois il faut re-scanner).
- Pour un bot 24h/24 stable, un VPS (Oracle Always Free) est mieux.
- Ne partage jamais ta `GEMINI_API_KEY`.

## Auteur

Créé pour la communauté éducative camerounaise.
