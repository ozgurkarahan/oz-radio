targetScope = 'subscription'

@minLength(1)
@maxLength(64)
@description('Name of the environment (used for resource naming)')
param environmentName string

@minLength(1)
@description('Primary location for all resources')
param location string

@description('Chat model deployment name')
param chatModelName string = 'gpt-4.1'

@description('Embedding model deployment name')
param embeddingModelName string = 'text-embedding-3-small'

@description('Image for the backend container (azd sets SERVICE_BACKEND_IMAGE_NAME after the first deploy; empty = placeholder image)')
param backendImageName string = ''

@minValue(0)
@maxValue(1)
@description('Container App minimum replicas. 0 = scale to zero when idle (the first request then waits about 30 s for a cold start). 1 = always on: about $47/month at idle rates, up to about $158/month if never idle, so raise BUDGET_AMOUNT. The maximum stays 1 because counters and quotas are in-process.')
param minReplicas int = 0

// ---------------------------------------------------------------------------
// Authentication / authorization (hybrid exposure model)
// ---------------------------------------------------------------------------

@description('Microsoft Entra ID app registration client ID for Easy Auth (empty disables Easy Auth; the preprovision hook refuses this unless ALLOW_INSECURE_NO_AUTH=true)')
param authClientId string = ''

@description('Microsoft Entra ID tenant ID (empty = tenant of the deployment subscription)')
param authTenantId string = ''

@secure()
@description('Client secret of the Easy Auth app registration')
param authClientSecret string = ''

@description('Comma-separated extra client application IDs allowed to call the app with bearer tokens. Empty = only the app itself.')
param authExtraClientApps string = ''

@description('Comma-separated Entra object IDs (oid) granted admin rights in the app')
param allowedObjectIds string = ''

@description('Comma-separated extra origins for CORS / WebSocket Origin check (empty = same-origin only)')
param allowedOrigins string = ''

@description('JSON array of custom photo avatars (see contract: id, display_name, character, gender, thumbnail, default)')
param customAvatarsJson string = ''

@description('Hide the stock avatars when at least one custom avatar is configured (true/false); stock ids become aliases to a same-gender custom avatar')
param hideStockAvatars string = 'false'

@description('Allow URL ingestion for podcasts (true/false)')
param enableUrlIngest string = 'false'

@description('Global concurrent /ws/voice sessions')
param maxVoiceSessions string = '2'

@description('Hard cap in seconds per voice session')
param maxVoiceSessionSeconds string = '900'

@description('Per-principal renders + uploads + chats per UTC day')
param dailyGenerationQuota string = '50'

@description('Global queued/running render jobs')
param maxPendingRenders string = '3'

@description('Podcast compose steps (ffmpeg video compose) running at once on the replica')
param maxConcurrentComposes string = '1'

@description('Batch avatar synthesis jobs active at once on the replica (podcast talking turns + listener kits)')
param maxActiveBatchJobs string = '8'

@description('Batch avatar job creations per rolling minute (the Speech service allows about 2)')
param speechBatchCreatePerMin string = '2'

@description('Kill switch: anonymous visitors of published podcasts can stream the audio (15-min SAS) and read the transcript (true/false)')
param podcastPublicAudio string = 'false'

@description('Kill switch for podcast listener backchannels ("mm-hmm", "right") in new renders (true/false)')
param podcastReactions string = 'false'

@allowed([
  'auto'
  'idle_loop'
  'procedural'
  'still'
])
@description('Podcast listener rendering: auto (cached idle loop, else procedural sway), idle_loop, procedural or still')
param podcastListenerMode string = 'auto'

@description('Seconds a podcast render waits for the listener kits before using the fallback listener (minimum 30)')
param podcastListenerTimeoutSec string = '900'

@description('Kill switch for the anonymous narration-only live avatar demo (true/false)')
param publicDemoEnabled string = 'false'

@description('Global concurrent anonymous demo sessions (separate from maxVoiceSessions)')
param demoMaxConcurrent string = '1'

@description('Hard cap in seconds per anonymous demo session')
param demoSessionSeconds string = '180'

@description('Anonymous demo sessions per UTC day (global)')
param demoDailySessions string = '20'

@description('Anonymous demo sessions per client IP per UTC day')
param demoDailySessionsPerIp string = '3'

@description('Hard daily cap on total public demo streaming minutes (durable, all visitors)')
param demoDailyMinutes string = '60'

@description('Narrations per demo session; 0 = 2 x slide count (hard max 40)')
param demoMaxSpeaks string = '0'

@description('Comma-separated client IPs/CIDRs exempt from the demo daily quotas (e.g. the owner\'s home IP). Empty = none.')
param demoQuotaExemptIps string = ''

@description('Raise-hand voice Q&A in the public demo (true/false, default off)')
param demoQaEnabled string = 'false'

@description('Questions per anonymous demo session when demo Q&A is enabled')
param demoQaMaxQuestions string = '2'

@description('Demo session cap in seconds when demo Q&A is enabled (replaces demoSessionSeconds)')
param demoQaSessionSeconds string = '300'

@description('Demo Q&A questions per UTC day (global, durable)')
param demoQaDailyMax string = '40'

@description('Demo Q&A questions per client IP per UTC day (durable)')
param demoQaDailyPerIp string = '6'

// ---------------------------------------------------------------------------
// External (pre-existing) AI Services / Speech resource, e.g. one hosting custom photo avatars
// ---------------------------------------------------------------------------

@description('Use an external (pre-existing) AI Services / Foundry resource instead of provisioning a new one')
param useExternalAiServices bool = false

@description('External AI Services endpoint (e.g. https://<name>.cognitiveservices.azure.com)')
param externalAiServicesEndpoint string = ''

@description('External AI Services region')
param externalAiServicesRegion string = ''

@description('External AI Services resource id (full ARM id; may live in another resource group of the same subscription)')
param externalAiServicesResourceId string = ''

@description('Grant the app identity Cognitive Services User, Cognitive Services Speech User and Foundry User on the external AI Services resource (requires Owner/User Access Administrator there)')
param assignExternalAiServicesRoles bool = true

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

@description('Send Blob read logs (StorageRead only: podcast audio SAS reads, status codes, user agents) to the Log Analytics workspace')
param enableBlobAccessLogs bool = true

// ---------------------------------------------------------------------------
// Governance
// ---------------------------------------------------------------------------

@description('JSON object of extra tags merged into every resource, e.g. {"CostCenter":"demo"} (empty = none)')
param extraTagsJson string = ''

@description('Monthly budget amount for the resource group (billing currency, typically USD)')
param budgetAmount int = 50

@description('Comma-separated e-mail recipients for budget alerts (empty = no budget is deployed)')
param budgetContactEmails string = ''

@description('Budget start date (yyyy-MM-01). Empty = first day of the current month. Pin it to keep re-provisions idempotent.')
param budgetStartDate string = ''

@description('Do not set: evaluated at deployment time to default the budget start date')
param deploymentMonthStart string = utcNow('yyyy-MM-01')

var abbrs = {
  resourceGroup: 'rg-'
  containerEnv: 'cae-'
  containerApp: 'ca-'
  containerRegistry: 'cr'
  managedIdentity: 'id-'
}

var resourceToken = toLower(uniqueString(subscription().id, environmentName, location))

var extraTags = empty(extraTagsJson) ? {} : json(extraTagsJson)
var tags = union(
  {
    'azd-env-name': environmentName
    project: 'ai-presenter'
  },
  extraTags
)

var effectiveAuthTenantId = empty(authTenantId) ? tenant().tenantId : authTenantId
var budgetEmails = filter(map(split(budgetContactEmails, ','), e => trim(e)), e => !empty(e))

resource rg 'Microsoft.Resources/resourceGroups@2022-09-01' = {
  name: '${abbrs.resourceGroup}${environmentName}'
  location: location
  tags: tags
}

// User-assigned identity: created first so registry pull + data-plane roles exist before the app starts
module identity 'modules/identity.bicep' = {
  name: 'identity'
  scope: rg
  params: {
    location: location
    identityName: '${abbrs.managedIdentity}${resourceToken}'
    tags: tags
  }
}

module registry 'modules/registry.bicep' = {
  name: 'registry'
  scope: rg
  params: {
    location: location
    acrName: '${abbrs.containerRegistry}${resourceToken}'
    pullPrincipalId: identity.outputs.principalId
    tags: tags
  }
}

// Provision Azure OpenAI with model deployments
module openai 'modules/openai.bicep' = {
  name: 'openai'
  scope: rg
  params: {
    location: location
    resourceToken: resourceToken
    chatModelName: chatModelName
    embeddingModelName: embeddingModelName
    tags: tags
  }
}

// Provision Azure AI Services (Speech/Avatar) — skipped when useExternalAiServices=true
module aiServices 'modules/ai-services.bicep' = if (!useExternalAiServices) {
  name: 'aiServices'
  scope: rg
  params: {
    location: location
    resourceToken: resourceToken
    tags: tags
  }
}

var speechEndpoint = useExternalAiServices ? externalAiServicesEndpoint : aiServices!.outputs.endpoint
var speechRegion = useExternalAiServices ? externalAiServicesRegion : location
var speechResourceId = useExternalAiServices ? externalAiServicesResourceId : aiServices!.outputs.resourceId
var aiServicesAccountName = useExternalAiServices ? '' : aiServices!.outputs.name

// /subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.CognitiveServices/accounts/{name}
var assignExternalRoles = useExternalAiServices && assignExternalAiServicesRoles && !empty(externalAiServicesResourceId)
var externalIdParts = split(
  assignExternalRoles ? externalAiServicesResourceId : '/subscriptions/${subscription().subscriptionId}/resourceGroups/unused/providers/Microsoft.CognitiveServices/accounts/unused',
  '/'
)

// Provision Cosmos DB (presentation persistence)
module cosmos 'modules/cosmos.bicep' = {
  name: 'cosmos'
  scope: rg
  params: {
    location: location
    resourceToken: resourceToken
    tags: tags
  }
}

// Provision Storage Account (slide images, rendered media)
module storage 'modules/storage.bicep' = {
  name: 'storage'
  scope: rg
  params: {
    location: location
    resourceToken: resourceToken
    tags: tags
  }
}

// Role assignments for the user-assigned managed identity
module roleAssignments 'modules/roles.bicep' = {
  name: 'roleAssignments'
  scope: rg
  params: {
    principalId: identity.outputs.principalId
    openAiAccountName: openai.outputs.name
    aiServicesAccountName: aiServicesAccountName
    cosmosAccountName: cosmos.outputs.name
    storageAccountName: storage.outputs.name
  }
}

module externalAiRoles 'modules/external-ai-roles.bicep' = if (assignExternalRoles) {
  name: 'externalAiRoles-${resourceToken}'
  scope: resourceGroup(externalIdParts[2], externalIdParts[4])
  params: {
    accountName: last(externalIdParts)
    principalId: identity.outputs.principalId
  }
}

module containerapp 'modules/containerapp.bicep' = {
  name: 'containerapp'
  scope: rg
  dependsOn: [
    roleAssignments
    externalAiRoles
  ]
  params: {
    envName: '${abbrs.containerEnv}${resourceToken}'
    appName: '${abbrs.containerApp}${resourceToken}'
    location: location
    containerImage: empty(backendImageName) ? 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest' : backendImageName
    minReplicas: minReplicas
    acrLoginServer: registry.outputs.loginServer
    identityId: identity.outputs.id
    identityClientId: identity.outputs.clientId
    speechEndpoint: speechEndpoint
    speechRegion: speechRegion
    speechResourceId: speechResourceId
    openAiEndpoint: openai.outputs.endpoint
    openAiChatDeployment: chatModelName
    openAiEmbeddingDeployment: embeddingModelName
    cosmosEndpoint: cosmos.outputs.endpoint
    storageAccountName: storage.outputs.name
    authClientId: authClientId
    authTenantId: effectiveAuthTenantId
    authClientSecret: authClientSecret
    authExtraClientApps: authExtraClientApps
    allowedObjectIds: allowedObjectIds
    allowedOrigins: allowedOrigins
    customAvatarsJson: customAvatarsJson
    hideStockAvatars: hideStockAvatars
    enableUrlIngest: enableUrlIngest
    maxVoiceSessions: maxVoiceSessions
    maxVoiceSessionSeconds: maxVoiceSessionSeconds
    dailyGenerationQuota: dailyGenerationQuota
    maxPendingRenders: maxPendingRenders
    maxConcurrentComposes: maxConcurrentComposes
    maxActiveBatchJobs: maxActiveBatchJobs
    speechBatchCreatePerMin: speechBatchCreatePerMin
    podcastPublicAudio: podcastPublicAudio
    podcastReactions: podcastReactions
    podcastListenerMode: podcastListenerMode
    podcastListenerTimeoutSec: podcastListenerTimeoutSec
    publicDemoEnabled: publicDemoEnabled
    demoMaxConcurrent: demoMaxConcurrent
    demoSessionSeconds: demoSessionSeconds
    demoDailySessions: demoDailySessions
    demoDailySessionsPerIp: demoDailySessionsPerIp
    demoDailyMinutes: demoDailyMinutes
    demoQuotaExemptIps: demoQuotaExemptIps
    demoMaxSpeaks: demoMaxSpeaks
    demoQaEnabled: demoQaEnabled
    demoQaMaxQuestions: demoQaMaxQuestions
    demoQaSessionSeconds: demoQaSessionSeconds
    demoQaDailyMax: demoQaDailyMax
    demoQaDailyPerIp: demoQaDailyPerIp
    tags: tags
  }
}

// Blob read logs: podcast audio is streamed from Blob Storage with SAS URLs the backend never sees
module blobAccessLogs 'modules/blob-access-logs.bicep' = if (enableBlobAccessLogs) {
  name: 'blobAccessLogs'
  scope: rg
  params: {
    storageAccountName: storage.outputs.name
    logAnalyticsWorkspaceId: containerapp.outputs.logAnalyticsWorkspaceId
  }
}

// Monthly cost guardrail (deployed only when at least one contact e-mail is provided)
module budget 'modules/budget.bicep' = if (!empty(budgetEmails)) {
  name: 'budget'
  scope: rg
  params: {
    budgetName: 'budget-${environmentName}'
    amount: budgetAmount
    contactEmails: budgetEmails
    startDate: empty(budgetStartDate) ? deploymentMonthStart : budgetStartDate
  }
}

output AZURE_RESOURCE_GROUP string = rg.name
output AZURE_LOCATION string = location
output AZURE_SPEECH_ENDPOINT string = speechEndpoint
output AZURE_SPEECH_REGION string = speechRegion
output AZURE_SPEECH_RESOURCE_ID string = speechResourceId
output AZURE_OPENAI_ENDPOINT string = openai.outputs.endpoint
output AZURE_OPENAI_CHAT_DEPLOYMENT string = chatModelName
output AZURE_OPENAI_EMBEDDING_DEPLOYMENT string = embeddingModelName
output AZURE_COSMOS_ENDPOINT string = cosmos.outputs.endpoint
output AZURE_BLOB_ACCOUNT_NAME string = storage.outputs.name
output AZURE_CONTAINER_APP_URL string = containerapp.outputs.url
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = registry.outputs.loginServer
output AZURE_CONTAINER_REGISTRY_LOGIN_SERVER string = registry.outputs.loginServer
output AZURE_MANAGED_IDENTITY_CLIENT_ID string = identity.outputs.clientId
