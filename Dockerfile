FROM apify/actor-node:22
COPY --chown=myuser package*.json ./
RUN npm --quiet set progress=false && npm install --omit=dev --omit=optional --no-audit && npm ls crawlee apify
COPY --chown=myuser . ./
CMD npm start --silent
