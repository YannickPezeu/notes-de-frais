#!/usr/bin/env pwsh
# Déploie notes-de-frais sur Kubernetes (expert-finder.epfl.ch/notes-de-frais).
# Usage : ./update.ps1

$ErrorActionPreference = "Stop"
$IMAGE = "ic-registry.epfl.ch/mr-pezeu/notes-de-frais:latest"
$NAMESPACE = "epfl-chatbot"
$DEPLOYMENT = "notes-de-frais"
$URL = "https://expert-finder.epfl.ch/notes-de-frais"

# (Un échec de commande native n'arrête PAS PowerShell malgré
# $ErrorActionPreference : d'où les tests explicites de $LASTEXITCODE.)
# Secret incomplet (ex. secret client Entra pas encore collé) : on ne déploie pas une connexion cassée.
if ((Test-Path k8s/secret.yaml) -and (Select-String -Path k8s/secret.yaml -Pattern 'REPLACE_ME' -Quiet)) {
  throw "k8s/secret.yaml contient encore REPLACE_ME : complétez-le avant de déployer"
}

Write-Host "=== 0/5 Tests ===" -ForegroundColor Cyan
node --test tests/core.test.mjs tests/server.test.mjs tests/stats.test.mjs
if ($LASTEXITCODE -ne 0) { throw "tests en échec" }

Write-Host "=== 1/5 Image Docker ===" -ForegroundColor Cyan
docker build -t $IMAGE .
if ($LASTEXITCODE -ne 0) { throw "docker build failed" }

Write-Host "=== 2/5 Push ===" -ForegroundColor Cyan
docker push $IMAGE
if ($LASTEXITCODE -ne 0) { throw "docker push failed" }
# Empreinte de l'image poussée : c'est elle que le pod exécutera (jamais « :latest »).
$IMAGE_REF = docker inspect --format '{{index .RepoDigests 0}}' $IMAGE
if ($LASTEXITCODE -ne 0 -or $IMAGE_REF -notmatch '@sha256:') { throw "empreinte de l'image introuvable" }

Write-Host "=== 3/5 Manifestes ===" -ForegroundColor Cyan
if (Test-Path k8s/secret.yaml) {
  kubectl apply -f k8s/secret.yaml
  if ($LASTEXITCODE -ne 0) { throw "secret apply failed" }
} else {
  kubectl get secret notes-de-frais-secrets -n $NAMESPACE | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "secret absent : copiez k8s/secret.yaml.example en k8s/secret.yaml et remplissez RCP_API_KEY" }
}
kubectl apply -f k8s/pvc.yaml -f k8s/service.yaml -f k8s/ingress.yaml
if ($LASTEXITCODE -ne 0) { throw "kubectl apply failed" }
# Image épinglée par empreinte + identifiant de déploiement (un redémarrage, même si seul le Secret a changé).
(Get-Content k8s/deployment.yaml -Raw).Replace($IMAGE, $IMAGE_REF).Replace('{{DEPLOY_ID}}', (Get-Date -Format o)) | kubectl apply -f -
if ($LASTEXITCODE -ne 0) { throw "kubectl apply deployment failed" }

Write-Host "=== 4/5 Redémarrage ===" -ForegroundColor Cyan
kubectl rollout status deployment/$DEPLOYMENT -n $NAMESPACE --timeout=120s
if ($LASTEXITCODE -ne 0) { throw "rollout failed" }

Write-Host "=== 5/5 Vérification ===" -ForegroundColor Cyan
# Le routeur (Traefik) met quelques secondes à voir un nouveau pod : on réessaie.
$health = $null
foreach ($i in 1..10) {
  try { $health = Invoke-RestMethod "$URL/healthz" -TimeoutSec 5; break } catch { Start-Sleep -Seconds 3 }
}
# ok = clé RCP et connexion EPFL configurées (sinon /healthz répond 503).
if (-not $health.ok) { throw "healthz KO : $($health | ConvertTo-Json -Compress)" }
# Pod le plus récent : juste après le redémarrage, l'ancien peut encore être listé (en arrêt).
$digest = kubectl get pods -n $NAMESPACE -l app=$DEPLOYMENT --sort-by=.metadata.creationTimestamp -o jsonpath="{.items[-1:].status.containerStatuses[0].imageID}"
Write-Host "OK : $URL  (image $digest)" -ForegroundColor Green
