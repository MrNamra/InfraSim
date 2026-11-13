<?php

namespace Database\Seeders;

use App\Models\Challenge;
use Illuminate\Database\Seeder;
use RuntimeException;
use Symfony\Component\Process\Process;

class ChallengeSeeder extends Seeder
{
    /**
     * Seed the canonical starter challenges compiled from `@infrasim/diagnosis`.
     */
    public function run(): void
    {
        $repoRoot = dirname(base_path(), 2);
        $entryPath = $repoRoot.'/packages/diagnosis/dist/challenges/starterChallenges.js';

        if (! is_file($entryPath)) {
            $buildProcess = new Process(['pnpm', '--filter', '@infrasim/diagnosis', 'build'], $repoRoot);
            $buildProcess->setTimeout(30);
            $buildProcess->run();
        }

        if (! is_file($entryPath)) {
            throw new RuntimeException(
                'Built challenge catalog missing at packages/diagnosis/dist/challenges/starterChallenges.js',
            );
        }

        $process = new Process(
            [
                'node',
                '-e',
                'import("./packages/diagnosis/dist/challenges/starterChallenges.js").then(m => process.stdout.write(JSON.stringify(m.STARTER_CHALLENGES)));',
            ],
            $repoRoot,
        );
        $process->setTimeout(15);
        $process->run();

        if (! $process->isSuccessful()) {
            throw new RuntimeException('Failed exporting starter challenges: '.$process->getErrorOutput());
        }

        $items = json_decode($process->getOutput(), true, 512, JSON_THROW_ON_ERROR);
        if (! is_array($items)) {
            throw new RuntimeException('Invalid JSON exported from starterChallenges.js');
        }

        foreach ($items as $challenge) {
            if (! is_array($challenge) || ! isset($challenge['slug'])) {
                continue;
            }
            Challenge::updateOrCreate(
                ['slug' => (string) $challenge['slug']],
                [
                    'title' => (string) ($challenge['title'] ?? $challenge['slug']),
                    'difficulty' => (string) ($challenge['difficulty'] ?? 'beginner'),
                    'definition' => $challenge,
                    'published' => (bool) ($challenge['published'] ?? true),
                ],
            );
        }
    }
}
