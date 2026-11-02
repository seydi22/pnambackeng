# ---- Étape 1: Builder ----
# Utilise une image Node.js légère pour installer les dépendances
FROM node:18-alpine AS builder

# Définit le répertoire de travail dans le conteneur
WORKDIR /app

# Copie package.json et package-lock.json pour installer les dépendances
COPY package.json package-lock.json ./

# Installe proprement les dépendances de production en utilisant package-lock.json
# L'option --only=production ignore les devDependencies
RUN npm ci --only=production

# ---- Étape 2: Production ----
# Utilise la même image de base pour la cohérence
FROM node:18-alpine AS production

# Définit le répertoire de travail
WORKDIR /app

# Crée un utilisateur non-root pour des raisons de sécurité
# Le groupe 'node' et l'utilisateur 'node' sont déjà présents dans l'image officielle Node
USER node

# Copie les dépendances installées depuis l'étape 'builder'
# Assure que les permissions sont correctes pour l'utilisateur 'node'
COPY --chown=node:node --from=builder /app/node_modules ./node_modules

# Copie le reste du code de l'application
# Assure que les permissions sont correctes pour l'utilisateur 'node'
COPY --chown=node:node . .

# Expose le port sur lequel l'application va écouter
# Le port réel sera mappé dans docker-compose.yml
EXPOSE 3000

# Commande pour démarrer l'application
# Utilise le script 'start' de votre package.json
CMD ["node", "server.js"]
