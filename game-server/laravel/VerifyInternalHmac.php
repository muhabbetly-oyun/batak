<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Oyun sunucusundan gelen ic API cagrilarini dogrular.
 *
 * Kayit (bootstrap/app.php veya Kernel.php):
 *   'internal.hmac' => \App\Http\Middleware\VerifyInternalHmac::class,
 *
 * Imza: HMAC-SHA256( "{timestamp}.{ham govde}", INTERNAL_API_SECRET )
 */
class VerifyInternalHmac
{
    public function handle(Request $request, Closure $next): Response
    {
        $secret = config('services.oyun.secret');   // .env: OYUN_INTERNAL_SECRET
        if (! $secret) {
            abort(500, 'OYUN_INTERNAL_SECRET tanimli degil');
        }

        // Yalnizca tunelden. Genel IP'den gelen cagri kabul edilmez.
        $allowed = config('services.oyun.allowed_ips', ['10.8.0.2']);
        if (! in_array($request->ip(), $allowed, true)) {
            abort(403, 'tunel disi');
        }

        $ts  = (int) $request->header('x-oyun-timestamp');
        $sig = (string) $request->header('x-oyun-signature');

        // Tekrar saldirisina karsi 5 dakikalik pencere.
        if (abs(time() - $ts) > 300) {
            abort(401, 'zaman damgasi gecersiz');
        }

        $expected = hash_hmac('sha256', $ts . '.' . $request->getContent(), $secret);
        if (! hash_equals($expected, $sig)) {
            abort(401, 'imza gecersiz');
        }

        return $next($request);
    }
}
