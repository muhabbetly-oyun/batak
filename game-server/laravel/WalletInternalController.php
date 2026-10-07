<?php

namespace App\Http\Controllers\Internal;

use App\Http\Controllers\Controller;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/**
 * Oyun sunucusunun cagirdigi ic cuzdan API'si.
 *
 * Jeton defteri BURADA. Oyun sunucusu MySQL'e hic baglanmaz; yalnizca bu
 * uclari cagirir. Tek ekonomi defteri, tek yedek, tek dogruluk kaynagi.
 *
 * Rotalar (routes/internal.php):
 *   Route::middleware('internal.hmac')->prefix('internal/wallet')->group(function () {
 *       Route::post('hold',    [WalletInternalController::class, 'hold']);
 *       Route::post('settle',  [WalletInternalController::class, 'settle']);
 *       Route::post('release', [WalletInternalController::class, 'release']);
 *   });
 *
 * Bu uclar YALNIZCA tunelden (10.8.0.2) erisilebilir olmali. ufw kurali:
 *   sudo ufw allow in on wg0 to any port 80 proto tcp
 */
class WalletInternalController extends Controller
{
    /** El basinda bahsi bloke eder. Biri yetmezse HICBIRI bloke edilmez. */
    public function hold(Request $request): JsonResponse
    {
        $data = $request->validate([
            'idempotencyKey' => ['required', 'string', 'max:128'],
            'tableId'        => ['required', 'string', 'max:64'],
            'handNo'         => ['required', 'integer', 'min:1'],
            'userIds'        => ['required', 'array', 'size:4'],
            'userIds.*'      => ['required', 'string'],
            'amount'         => ['required', 'integer', 'min:0'],
        ]);

        return DB::transaction(function () use ($data) {
            // Idempotans: ayni anahtar ikinci kez para hareketi yaratmaz.
            $existing = DB::table('wallet_ledger')
                ->where('idempotency_key', $data['idempotencyKey'])
                ->first();
            if ($existing) {
                return response()->json([
                    'balances' => $this->balances($data['userIds']),
                    'replayed' => true,
                ]);
            }

            // Kilitli okuma: ayni anda iki masa ayni bakiyeyi harcamasin.
            $wallets = DB::table('wallets')
                ->whereIn('user_id', $data['userIds'])
                ->lockForUpdate()
                ->get()
                ->keyBy('user_id');

            $short = [];
            foreach ($data['userIds'] as $uid) {
                $available = ($wallets[$uid]->balance ?? 0) - ($wallets[$uid]->held ?? 0);
                if ($available < $data['amount']) {
                    $short[] = $uid;
                }
            }
            if ($short) {
                return response()->json([
                    'code'    => 'INSUFFICIENT_FUNDS',
                    'userIds' => $short,
                ], 409);
            }

            foreach ($data['userIds'] as $uid) {
                DB::table('wallets')->where('user_id', $uid)
                    ->increment('held', $data['amount']);
            }

            DB::table('wallet_ledger')->insert([
                'idempotency_key' => $data['idempotencyKey'],
                'table_id'        => $data['tableId'],
                'hand_no'         => $data['handNo'],
                'op'              => 'hold',
                'payload'         => json_encode($data),
                'created_at'      => now(),
            ]);

            return response()->json(['balances' => $this->balances($data['userIds'])]);
        });
    }

    /** El sonunda bloke acilir ve net degisim yazilir. */
    public function settle(Request $request): JsonResponse
    {
        $data = $request->validate([
            'idempotencyKey' => ['required', 'string', 'max:128'],
            'tableId'        => ['required', 'string', 'max:64'],
            'handNo'         => ['required', 'integer', 'min:1'],
            'userIds'        => ['required', 'array', 'size:4'],
            'userIds.*'      => ['required', 'string'],
            'deltas'         => ['required', 'array', 'size:4'],
            'deltas.*'       => ['required', 'integer'],
        ]);

        return DB::transaction(function () use ($data) {
            $existing = DB::table('wallet_ledger')
                ->where('idempotency_key', $data['idempotencyKey'])
                ->first();
            if ($existing) {
                return response()->json([
                    'balances' => $this->balances($data['userIds']),
                    'replayed' => true,
                ]);
            }

            $hold = DB::table('wallet_ledger')
                ->where('table_id', $data['tableId'])
                ->where('hand_no', $data['handNo'])
                ->where('op', 'hold')
                ->first();
            $heldAmount = $hold
                ? (json_decode($hold->payload, true)['amount'] ?? 0)
                : 0;

            DB::table('wallets')
                ->whereIn('user_id', $data['userIds'])
                ->lockForUpdate()
                ->get();

            foreach ($data['userIds'] as $i => $uid) {
                DB::table('wallets')->where('user_id', $uid)->update([
                    'held'    => DB::raw("GREATEST(held - {$heldAmount}, 0)"),
                    'balance' => DB::raw('balance + ' . (int) $data['deltas'][$i]),
                ]);
            }

            DB::table('wallet_ledger')->insert([
                'idempotency_key' => $data['idempotencyKey'],
                'table_id'        => $data['tableId'],
                'hand_no'         => $data['handNo'],
                'op'              => 'settle',
                'payload'         => json_encode($data),
                'created_at'      => now(),
            ]);

            return response()->json(['balances' => $this->balances($data['userIds'])]);
        });
    }

    /** El iptal edildiginde blokeyi geri verir. */
    public function release(Request $request): JsonResponse
    {
        $data = $request->validate([
            'idempotencyKey' => ['required', 'string', 'max:128'],
            'tableId'        => ['required', 'string', 'max:64'],
            'handNo'         => ['required', 'integer', 'min:1'],
            'userIds'        => ['required', 'array', 'size:4'],
            'userIds.*'      => ['required', 'string'],
            'amount'         => ['required', 'integer', 'min:0'],
        ]);

        return DB::transaction(function () use ($data) {
            $existing = DB::table('wallet_ledger')
                ->where('idempotency_key', $data['idempotencyKey'])
                ->first();
            if ($existing) {
                return response()->json([
                    'balances' => $this->balances($data['userIds']),
                    'replayed' => true,
                ]);
            }

            foreach ($data['userIds'] as $uid) {
                DB::table('wallets')->where('user_id', $uid)->update([
                    'held' => DB::raw('GREATEST(held - ' . (int) $data['amount'] . ', 0)'),
                ]);
            }

            DB::table('wallet_ledger')->insert([
                'idempotency_key' => $data['idempotencyKey'],
                'table_id'        => $data['tableId'],
                'hand_no'         => $data['handNo'],
                'op'              => 'release',
                'payload'         => json_encode($data),
                'created_at'      => now(),
            ]);

            return response()->json(['balances' => $this->balances($data['userIds'])]);
        });
    }

    private function balances(array $userIds): array
    {
        return DB::table('wallets')
            ->whereIn('user_id', $userIds)
            ->pluck('balance', 'user_id')
            ->toArray();
    }
}
