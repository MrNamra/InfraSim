<?php

use Illuminate\Foundation\Inspiring;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Schedule;

Artisan::command('inspire', function () {
    $this->comment(Inspiring::quote());
})->purpose('Display an inspiring quote');

Schedule::command('prices:sync --provider=all --regions=us-east-1,eastus,us-east4')
    ->dailyAt('03:15')
    ->withoutOverlapping()
    ->onOneServer();

Schedule::command('designs:prune-versions --keep=50')
    ->weeklyOn(1, '04:00')
    ->withoutOverlapping()
    ->onOneServer();
