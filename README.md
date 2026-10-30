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
| `STATUS_RECIPIENTS` | Non | Numéros WhatsApp séparés par des virgules pour l’audience `liste` |
| `BOT_DATA_DIR` | Non | Dossier des programmations, réglages et journal (défaut : `./data`) |
| `WHATSAPP_CHANNEL_URL` | Non | Lien d’invitation du canal Mathsfor.all (valeur par défaut : canal fourni) |
| `POLL_TIMES` | Non | Exactement cinq heures `HH:MM`, séparées par des virgules (défaut : `08:00,11:00,14:00,17:00,20:00`) |
| `POLL_TIMEZONE` | Non | Fuseau des publications (défaut : `Africa/Douala`) |

Sur **Render**, tu ne crées pas de fichier `.env` : tu ajoutes chaque variable dans **Environment**.
Si un modèle échoue, l’agent essaie le suivant dans cet ordre. Les modèles partagent le quota Gemini de ta clé/projet : un quota épuisé globalement peut bloquer toute la chaîne.

## Fonctions et commandes

Les commandes admin sont accessibles uniquement depuis le numéro `ADMIN_NUMBER`.

- **Statuts avec aperçu obligatoire** : `statut: texte`, `statut connus: texte` ou `statut liste: texte`. Envoie une image ou une vidéo avec cette commande en légende pour préparer un statut média. Le bot affiche l’aperçu et l’audience ; `confirmer statut` publie, `annuler statut` abandonne. La légende est limitée à 700 caractères et le bot refuse les fichiers de plus de 64 Mo. WhatsApp limite les vidéos de statut à 90 secondes ([aide WhatsApp](https://faq.whatsapp.com/454876960047011)).
- **Audience connue** : contacts directs ayant déjà écrit au bot. **Audience liste** : numéros indiqués dans `STATUS_RECIPIENTS`, séparés par des virgules, au format international sans `+`.
- **Programmation** : `statut dans 15m: texte` prépare un statut dans 15 minutes. Après `confirmer statut`, il est ajouté à la file. `!statuts` liste les publications prévues et `!annulerstatut ID` en supprime une. Les horaires acceptés vont d’une minute à sept jours.
- **Réponses rapides** : les clients peuvent écrire `!tarifs`, `!inscription` ou `!contact`. L’admin peut lister les clés avec `!reponses` et changer une réponse avec `!reponse tarifs | nouveau texte`.
- **Mode maintenance** : `!maintenance on` / `!maintenance off`, ou les raccourcis `!pause` et `!resume`. Les dépôts restent signalés à l’admin.
- **Mémoire courte** : l’agent garde jusqu’à six échanges par conversation pendant la vie du processus. `!reset` efface sa propre mémoire ; l’admin peut faire `!reset NUMERO` pour celle d’un contact.
- **Intervention humaine et journal** : les demandes de conseiller, réclamations et urgences déclenchent une notification admin, limitée à une par contact toutes les 30 minutes. `!journal` affiche les dix derniers événements.
- **Sondages du canal Mathsfor.all** : Baileys retrouve l’identifiant interne depuis `WHATSAPP_CHANNEL_URL`; le compte WhatsApp lié doit être administrateur ou propriétaire du canal. Après déploiement et vérification du rôle, l’admin active explicitement l’automatisation avec `!sondages on`. Le bot programme cinq sondages par jour (mathématiques, informatique, chimie, physique, culture scientifique) entre Seconde S et L2, puis publie un corrigé et les liens Instagram, Facebook, TikTok, WhatsApp, YouTube, cmr-school.online et Shop Mathsfor.all 30 minutes après le dernier. `!sondages status`, `!sondages aperçu` et `!sondages off` permettent de contrôler, prévisualiser et arrêter les publications. L’IA Gemini génère les quiz du jour; une banque de questions locale évite de bloquer le calendrier si le quota est épuisé.

L’état opérationnel (contacts connus, réponses rapides, mode maintenance, tâches programmées, activation des sondages et journal) est stocké dans `BOT_DATA_DIR`. Sur un hébergement à disque éphémère, il peut être perdu au redéploiement ; configure un volume persistant et règle `BOT_DATA_DIR` sur son point de montage si tu veux conserver ces données. Pour publier à l’heure, le service doit rester actif 24 h/24 : un plan qui met le service en veille ou un redémarrage prolongé peut faire manquer des publications. Le bot abandonne une publication en retard de plus de 15 minutes plutôt que d’inonder le canal au redémarrage. La mémoire de conversation, elle, reste volontairement en RAM et s’efface au redémarrage.

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
