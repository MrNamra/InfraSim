<?php

return [
    'sync_enabled' => filter_var(env('PRICE_SYNC_ENABLED', false), FILTER_VALIDATE_BOOLEAN),

    'stale_after_days' => (int) env('PRICE_SYNC_STALE_DAYS', 7),

    'admin_email' => env('PRICE_SYNC_ADMIN_EMAIL'),

    'max_runtime_seconds' => (int) env('PRICE_SYNC_MAX_RUNTIME_SECONDS', 240),

    'max_pages' => (int) env('PRICE_SYNC_MAX_PAGES', 100),

    'alert_change_fraction' => 0.20,

    'alert_pct_delta' => 0.30,

    'sku_map_path' => env('PRICE_SKU_MAP_PATH', base_path('../../packages/cost-engine/data/price_sku_map.json')),

    'catalog_dir' => env('INFRASIM_CATALOG_DIR', base_path('../../packages/catalog/data')),

    'sources' => [
        'aws' => [
            'index_url' => env('AWS_PRICING_INDEX_URL', 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/index.json'),
            'base_url' => 'https://pricing.us-east-1.amazonaws.com',
        ],
        'azure' => [
            'api_url' => env('AZURE_PRICING_API_URL', 'https://prices.azure.com/api/retail/prices'),
            'api_version' => '2023-01-01-preview',
        ],
        'gcp' => [
            'base_url' => env('GCP_BILLING_API_URL', 'https://cloudbilling.googleapis.com/v1'),
            'api_key' => env('GCP_BILLING_API_KEY'),
        ],
        'oci' => [
            'products_url' => env('OCI_PRICING_API_URL', 'https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/'),
        ],
    ],
];
