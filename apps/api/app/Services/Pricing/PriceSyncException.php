<?php

namespace App\Services\Pricing;

use RuntimeException;

/**
 * Raised when a price source fetch, validation, or normalization fails loudly.
 */
class PriceSyncException extends RuntimeException {}
