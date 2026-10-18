@description('Name of the Container App Environment')
param envName string

@description('Name of the Container App')
param appName string

@description('Location for the resource')
param location string

@description('Container image to deploy')
param containerImage string

@description('Login server of the Container Registry (pulled with the user-assigned identity)')
param acrLoginServer string

@description('Resource ID of the user-assigned managed identity used for registry pull and data-plane access')
param identityId string

@description('Client ID of the user-assigned managed identity (exposed as AZURE_CLIENT_ID for DefaultAzureCredential)')
param identityClientId string

@description('Azure Speech endpoint')
param speechEndpoint string

@description('Azure Speech region')
param speechRegion string

@description('Azure Speech resource ID (for AAD token exchange)')
param speechResourceId string

@description('Azure OpenAI endpoint')
param openAiEndpoint string

@description('Azure OpenAI chat deployment name')
param openAiChatDeployment string

@description('Azure OpenAI embedding deployment name')
param openAiEmbeddingDeployment string

@description('Azure Cosmos DB endpoint')
param cosmosEndpoint string

@description('Azure Storage Account name')
param storageAccountName string

@description('Azure Blob container name')
param blobContainerName string = 'slide-images'

@description('vCPU per replica (ffmpeg compositing for video/podcast renders benefits from 2)')
param containerCpu string = '2'

@description('Memory per replica (must match the CPU ratio, e.g. 2 vCPU => 4Gi)')
param containerMemory string = '4Gi'

@description('Microsoft Entra ID app registration client ID for Easy Auth (empty disables Easy Auth; nobody is admin)')
param authClientId string = ''

@description('Comma-separated extra client application IDs allowed to call the app with bearer tokens (e.g. Azure CLI for scripted tests). Empty = only the app itself.')
param authExtraClientApps string = ''

@description('Microsoft Entra ID tenant ID used for the Easy Auth issuer and the AUTH_TENANT_ID check')
param authTenantId string = tenant().tenantId

@secure()
@description('Client secret of the Easy Auth app registration (stored as a Container App secret)')
param authClientSecret string = ''

@description('Comma-separated Entra object IDs allowed as admin')
param allowedObjectIds string = ''

@description('Comma-separated extra origins for CORS / WebSocket Origin check (empty = same-origin only)')
param allowedOrigins string = ''

@description('JSON array describing custom photo avatars (empty = stock avatars only)')
param customAvatarsJson string = ''

@description('Hide the stock avatars when at least one custom avatar is configured (true/false)')
param hideStockAvatars string = 'false'

@description('Allow URL ingestion for podcasts')
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

@description('Kill switch: anonymous visitors of published podcasts can stream the audio and read the transcript (true/false)')
param podcastPublicAudio string = 'false'

@description('Kill switch for podcast listener backchannels in new renders (true/false)')
param podcastReactions string = 'false'

@allowed([
  'auto'
  'idle_loop'
  'procedural'
  'still'
])
@description('Podcast listener rendering: auto, idle_loop, procedural or still')
param podcastListenerMode string = 'auto'

@description('Seconds a podcast render waits for the listener kits before using the fallback listener')
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

@description('Hard daily cap on total public demo streaming minutes')
param demoDailyMinutes string = '60'

@description('Narrations per demo session; 0 = 2 x slide count (hard max 40)')
param demoMaxSpeaks string = '0'

@description('Comma-separated client IPs/CIDRs exempt from the demo daily quotas')
param demoQuotaExemptIps string = ''

@description('Raise-hand voice Q&A in the public demo (true/false)')
param demoQaEnabled string = 'false'

@description('Questions per anonymous demo session when demo Q&A is enabled')
param demoQaMaxQuestions string = '2'

@description('Demo session cap in seconds when demo Q&A is enabled')
param demoQaSessionSeconds string = '300'

@description('Demo Q&A questions per UTC day (global)')
param demoQaDailyMax string = '40'

@description('Demo Q&A questions per client IP per UTC day')
param demoQaDailyPerIp string = '6'

@description('Tags to apply to every resource')
param tags object = {}

var authEnabled = !empty(authClientId)
var authSecretName = 'microsoft-provider-authentication-secret'
var hasAuthSecret = authEnabled && !empty(authClientSecret)

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${envName}-logs'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource containerEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: envName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        // Key is resolved inside this module only; it is never emitted as an output.
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
  tags: tags
}

resource containerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerEnv.id
    configuration: {
      ingress: {
        external: true
        targetPort: 8000
        transport: 'auto'
        allowInsecure: false
      }
      secrets: hasAuthSecret ? [
        { name: authSecretName, value: authClientSecret }
      ] : []
      registries: [
        {
          server: acrLoginServer
          identity: identityId
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'backend'
          image: containerImage
          resources: {
            cpu: json(containerCpu)
            memory: containerMemory
          }
          env: [
            { name: 'AZURE_CLIENT_ID', value: identityClientId }
            { name: 'AZURE_SPEECH_ENDPOINT', value: speechEndpoint }
            { name: 'AZURE_SPEECH_REGION', value: speechRegion }
            { name: 'AZURE_SPEECH_RESOURCE_ID', value: speechResourceId }
            { name: 'AZURE_OPENAI_ENDPOINT', value: openAiEndpoint }
            { name: 'AZURE_OPENAI_CHAT_DEPLOYMENT', value: openAiChatDeployment }
            { name: 'AZURE_OPENAI_EMBEDDING_DEPLOYMENT', value: openAiEmbeddingDeployment }
            { name: 'AZURE_USE_MANAGED_IDENTITY', value: 'true' }
            { name: 'USE_LOCAL_SEARCH', value: 'true' }
            { name: 'AZURE_COSMOS_ENDPOINT', value: cosmosEndpoint }
            { name: 'AZURE_BLOB_ACCOUNT_NAME', value: storageAccountName }
            { name: 'AZURE_BLOB_CONTAINER', value: blobContainerName }
            // Always trust only Easy Auth headers. Without Easy Auth configured the
            // allowlist is forced empty so spoofed principal headers can never grant admin.
            { name: 'AUTH_MODE', value: 'easyauth' }
            { name: 'AUTH_TENANT_ID', value: authTenantId }
            { name: 'ALLOWED_OBJECT_IDS', value: authEnabled ? allowedObjectIds : '' }
            { name: 'ALLOWED_ORIGINS', value: allowedOrigins }
            { name: 'CUSTOM_AVATARS_JSON', value: customAvatarsJson }
            { name: 'HIDE_STOCK_AVATARS', value: hideStockAvatars }
            { name: 'ENABLE_URL_INGEST', value: enableUrlIngest }
            { name: 'MAX_VOICE_SESSIONS', value: maxVoiceSessions }
            { name: 'MAX_VOICE_SESSION_SECONDS', value: maxVoiceSessionSeconds }
            { name: 'DAILY_GENERATION_QUOTA', value: dailyGenerationQuota }
            { name: 'MAX_PENDING_RENDERS', value: maxPendingRenders }
            { name: 'MAX_CONCURRENT_COMPOSES', value: maxConcurrentComposes }
            { name: 'MAX_ACTIVE_BATCH_JOBS', value: maxActiveBatchJobs }
            { name: 'SPEECH_BATCH_CREATE_PER_MIN', value: speechBatchCreatePerMin }
            { name: 'PODCAST_PUBLIC_AUDIO', value: podcastPublicAudio }
            { name: 'PODCAST_REACTIONS', value: podcastReactions }
            { name: 'PODCAST_LISTENER_MODE', value: podcastListenerMode }
            { name: 'PODCAST_LISTENER_TIMEOUT_SEC', value: podcastListenerTimeoutSec }
            { name: 'PUBLIC_DEMO_ENABLED', value: publicDemoEnabled }
            { name: 'DEMO_MAX_CONCURRENT', value: demoMaxConcurrent }
            { name: 'DEMO_SESSION_SECONDS', value: demoSessionSeconds }
            { name: 'DEMO_DAILY_SESSIONS', value: demoDailySessions }
            { name: 'DEMO_DAILY_SESSIONS_PER_IP', value: demoDailySessionsPerIp }
            { name: 'DEMO_DAILY_MINUTES', value: demoDailyMinutes }
            { name: 'DEMO_MAX_SPEAKS', value: demoMaxSpeaks }
            { name: 'DEMO_QUOTA_EXEMPT_IPS', value: demoQuotaExemptIps }
            { name: 'DEMO_QA_ENABLED', value: demoQaEnabled }
            { name: 'DEMO_QA_MAX_QUESTIONS', value: demoQaMaxQuestions }
            { name: 'DEMO_QA_SESSION_SECONDS', value: demoQaSessionSeconds }
            { name: 'DEMO_QA_DAILY_MAX', value: demoQaDailyMax }
            { name: 'DEMO_QA_DAILY_PER_IP', value: demoQaDailyPerIp }
          ]
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 1
        rules: [
          {
            name: 'http-rule'
            http: {
              metadata: {
                concurrentRequests: '50'
              }
            }
          }
        ]
      }
    }
  }
  tags: union(tags, { 'azd-service-name': 'backend' })
}

// Easy Auth – Microsoft Entra ID (enabled when authClientId is provided).
// Hybrid exposure: anonymous requests reach the app, which enforces per-route authorization
// from the X-MS-CLIENT-PRINCIPAL headers injected (and sanitised) by the platform.
resource authConfig 'Microsoft.App/containerApps/authConfigs@2024-03-01' = if (authEnabled) {
  parent: containerApp
  name: 'current'
  properties: {
    platform: {
      enabled: true
    }
    globalValidation: {
      unauthenticatedClientAction: 'AllowAnonymous'
    }
    httpSettings: {
      requireHttps: true
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: union(
          {
            clientId: authClientId
            openIdIssuer: '${environment().authentication.loginEndpoint}${authTenantId}/v2.0'
          },
          hasAuthSecret ? { clientSecretSettingName: authSecretName } : {}
        )
        validation: {
          allowedAudiences: [
            'api://${authClientId}'
            authClientId
          ]
          defaultAuthorizationPolicy: {
            allowedApplications: concat([authClientId], filter(map(split(authExtraClientApps, ','), a => trim(a)), a => !empty(a)))
          }
        }
      }
    }
  }
}

output url string = 'https://${containerApp.properties.configuration.ingress.fqdn}'
output name string = containerApp.name
output logAnalyticsWorkspaceId string = logAnalytics.id
