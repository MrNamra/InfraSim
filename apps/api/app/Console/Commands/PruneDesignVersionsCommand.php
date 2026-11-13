<?php

namespace App\Console\Commands;

use App\Models\Design;
use App\Models\DesignVersion;
use Illuminate\Console\Command;

class PruneDesignVersionsCommand extends Command
{
    protected $signature = 'designs:prune-versions
        {--keep=50 : Number of latest versions to keep per design}';

    protected $description = 'Prune historical design versions, keeping the latest N versions per design';

    public function handle(): int
    {
        $keep = max(1, (int) $this->option('keep'));
        $this->info("Pruning design versions (retaining latest {$keep} per design)...");

        $totalPruned = 0;
        $designsCount = 0;

        $designIds = Design::withTrashed()->pluck('id');

        foreach ($designIds as $designId) {
            $designsCount++;
            $keepVersions = DesignVersion::where('design_id', $designId)
                ->orderByDesc('version')
                ->limit($keep)
                ->pluck('version');

            if ($keepVersions->isEmpty()) {
                continue;
            }

            $deleted = DesignVersion::where('design_id', $designId)
                ->whereNotIn('version', $keepVersions)
                ->delete();

            $totalPruned += $deleted;
        }

        $this->info("Pruned {$totalPruned} version(s) across {$designsCount} design(s).");

        return self::SUCCESS;
    }
}
