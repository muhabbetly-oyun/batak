<?php

namespace App\Http\Controllers;

use Firebase\JWT\JWT;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\Auth;

/**
 * Oyun sunucusuna girmek icin kisa omurlu bilet uretir.
 *
 * Private key BURADA kalir. Oyun sunucusu yalnizca public key tutar ve
 * muhabbetly'ye hic sormadan dogrular. Oyun tarafi parola, oturum veya
 * MySQL gormez.
 *
 * Rota:  Route::middleware('auth')->get('/oyun/bilet', GameTokenController::class);
 */
class GameTokenController extends Controller
{
    public function __invoke(): JsonResponse
    {
        $user = Auth::user();
        $now  = time();

        $token = JWT::encode([
            'iss'      => 'muhabbetly',
            'aud'      => 'game',
            'sub'      => (string) $user->id,
            'username' => $user->name,
            'iat'      => $now,
            // 5 dakika. Uzatmayin; yenilemeyi istemci yapar.
            'exp'      => $now + 300,
        ], file_get_contents(storage_path('jwt-private.pem')), 'RS256');

        return response()->json([
            'token' => $token,
            'ws'    => 'wss://oyun.muhabbetly.com/ws',
            'expiresIn' => 300,
        ]);
    }
}
