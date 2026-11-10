<?php

namespace App\Http\Controllers;

use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;

class HealthController extends Controller
{
    /**
     * Report API and database connectivity status.
     */
    public function __invoke(): JsonResponse
    {
        DB::select('select 1');

        return response()->json([
            'status' => 'ok',
            'service' => 'infrasim-api',
        ]);
    }
}
