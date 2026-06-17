#!/usr/bin/env bash
# =====================================================================
# AAA web :: one-time setup to deploy web/ to Azure Container Apps,
# REUSING the existing shared registry 'aiempregistry'.
# ---------------------------------------------------------------------
# Run after `az login`. Idempotent (each step checks for what exists).
#   az login
#   ./deploy/azure-containerapp.sh
#
# It: registers providers, creates the Container Apps environment + the
# aaa-web app (bootstrapped, then switched to our image), wires the app's
# managed identity to pull from aiempregistry, and grants THIS repo's
# GitHub OIDC identity (github-aaa-web-deploy) AcrPush + Contributor so the
# workflow can build/push/roll out. The 3 AZURE_* GitHub secrets from the
# earlier App Service setup are reused unchanged.
# =====================================================================
set -uo pipefail

# ── EDIT THESE ───────────────────────────────────────────────────────
RG=aaa-rg                    # resource group (already exists, in eastus)
LOC=westus2                  # env + app region (co-located with the shared ACR)
ENVNAME=aaa-env              # Container Apps managed environment
APP=aaa-web                  # the container app  (== AZURE_WEBAPP/IMAGE in the workflow)
ACR=aiempregistry            # EXISTING shared registry (reused)
IMAGE=aaa-web                # image repository inside that registry
REPO=reginat-richtech/AAA    # GitHub repo whose OIDC identity deploys
DEPLOY_APP_DISPLAY=github-aaa-web-deploy   # the Entra app reg created earlier
PORT=3100                    # the port the Next.js standalone server listens on
# ─────────────────────────────────────────────────────────────────────

command -v az >/dev/null || { echo "ERROR: az not found — brew install azure-cli"; exit 1; }
az account show >/dev/null 2>&1 || { echo "ERROR: not logged in — run: az login"; exit 1; }
az extension show -n containerapp >/dev/null 2>&1 || az extension add -n containerapp -o none

SUB=$(az account show --query id -o tsv)
echo "==> subscription $SUB"

# 0) Providers
for p in Microsoft.App Microsoft.OperationalInsights; do
  state=$(az provider show -n "$p" --query registrationState -o tsv 2>/dev/null)
  [ "$state" = "Registered" ] || { echo "  .. registering $p"; az provider register -n "$p" -o none; }
done

# Registry must already exist (it's the shared one)
ACR_ID=$(az acr show -n "$ACR" --query id -o tsv 2>/dev/null) || { echo "ERROR: registry $ACR not found"; exit 2; }
ACR_LOGIN=$(az acr show -n "$ACR" --query loginServer -o tsv)
echo "==> reusing registry $ACR ($ACR_LOGIN)"

# 1) Resource group (created in the earlier setup)
az group show -n "$RG" >/dev/null 2>&1 \
  && echo "  ok   resource group $RG" \
  || { az group create -n "$RG" -l "$LOC" -o none && echo "  new  resource group $RG"; }

# 2) Container Apps environment (auto-creates a Log Analytics workspace)
az containerapp env show -g "$RG" -n "$ENVNAME" >/dev/null 2>&1 \
  && echo "  ok   environment $ENVNAME (exists)" \
  || { echo "  .. creating environment $ENVNAME (~2 min)"; az containerapp env create -g "$RG" -n "$ENVNAME" -l "$LOC" -o none && echo "  new  environment $ENVNAME"; }

# 3) First image build — in the cloud, so no local Docker is needed
echo "==> building $ACR_LOGIN/$IMAGE:init via ACR (cloud build, ~3 min)…"
az acr build -r "$ACR" -t "$IMAGE:init" -t "$IMAGE:latest" web -o none \
  || { echo "  FAIL image build"; exit 3; }

# 4) Container app — bootstrap with a public image if it doesn't exist yet
if az containerapp show -g "$RG" -n "$APP" >/dev/null 2>&1; then
  echo "  ok   container app $APP (exists)"
else
  az containerapp create -g "$RG" -n "$APP" --environment "$ENVNAME" \
    --image mcr.microsoft.com/azuredocs/containerapps-helloworld:latest \
    --target-port 80 --ingress external --min-replicas 0 --max-replicas 2 \
    --system-assigned -o none && echo "  new  container app $APP (bootstrap)"
fi

# 5) Let the app pull from the shared registry via its managed identity
PRINCIPAL=$(az containerapp identity show -g "$RG" -n "$APP" --query principalId -o tsv)
az role assignment create --assignee-object-id "$PRINCIPAL" --assignee-principal-type ServicePrincipal \
  --role AcrPull --scope "$ACR_ID" -o none 2>/dev/null \
  && echo "  new  AcrPull (app identity)" || echo "  ok   AcrPull present"
echo "  .. waiting 15s for the role to propagate"; sleep 15
az containerapp registry set -g "$RG" -n "$APP" --server "$ACR_LOGIN" --identity system -o none

# 6) Switch to our image + the right port
az containerapp update        -g "$RG" -n "$APP" --image "$ACR_LOGIN/$IMAGE:init" -o none
az containerapp ingress update -g "$RG" -n "$APP" --target-port "$PORT" -o none

# 7) Grant the GitHub OIDC identity push + rollout rights
DEPLOY_APP_ID=$(az ad app list --display-name "$DEPLOY_APP_DISPLAY" --query "[0].appId" -o tsv)
if [ -n "$DEPLOY_APP_ID" ]; then
  az role assignment create --assignee "$DEPLOY_APP_ID" --role AcrPush --scope "$ACR_ID" -o none 2>/dev/null \
    && echo "  new  AcrPush (GitHub identity)" || echo "  ok   AcrPush present"
  az role assignment create --assignee "$DEPLOY_APP_ID" --role Contributor \
    --scope "/subscriptions/$SUB/resourceGroups/$RG" -o none 2>/dev/null \
    && echo "  new  Contributor on $RG (GitHub identity)" || echo "  ok   Contributor present"
else
  echo "  !!   app registration '$DEPLOY_APP_DISPLAY' not found — run deploy/azure-setup.sh steps 4-6 first"
fi

URL=$(az containerapp show -g "$RG" -n "$APP" --query properties.configuration.ingress.fqdn -o tsv)
cat <<EOF

==> Container App is up:  https://$URL
    STILL TO DO (fill in real values):
      1) Runtime env (app crashes on boot without these):
           az containerapp update -g $RG -n $APP --set-env-vars \\
             DATABASE_URL="postgresql://app_rw:<pw>@<host>.postgres.database.azure.com:5432/aaa?sslmode=require" \\
             OPENAI_API_KEY="<key>" OPENAI_MODEL="gpt-4.1" \\
             AUTH_SECRET="\$(openssl rand -base64 32)" AUTH_URL="https://$URL" \\
             GOOGLE_CLIENT_ID="<id>" GOOGLE_CLIENT_SECRET="<secret>" \\
             ALLOWED_OAUTH_DOMAINS="richtechsystem.com,richtechrobotics.com" \\
             ADMIN_EMAILS="dev@richtechsystem.com"
      2) Google OAuth client → add redirect URI:  https://$URL/api/auth/callback/google
      3) Push to main (or run the "Deploy web" workflow) — CI builds + rolls out new images.
EOF
