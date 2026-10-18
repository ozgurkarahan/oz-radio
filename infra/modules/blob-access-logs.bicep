// Blob read logs -> Log Analytics (table StorageBlobLogs). Podcast audio is streamed
// straight from Blob Storage with SAS URLs, so the backend never sees those requests.
// Only the StorageRead category is sent: no StorageWrite/StorageDelete, no metrics.

@description('Name of the existing Storage account')
param storageAccountName string

@description('Resource ID of the existing Log Analytics workspace')
param logAnalyticsWorkspaceId string

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' existing = {
  parent: storageAccount
  name: 'default'
}

resource blobAccessLogs 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'blob-access-logs'
  scope: blobService
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      {
        category: 'StorageRead'
        enabled: true
      }
    ]
  }
}
