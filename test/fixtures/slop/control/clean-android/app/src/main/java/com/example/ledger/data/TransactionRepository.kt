package com.example.ledger.data

import android.database.sqlite.SQLiteException
import com.example.ledger.remote.RatesApi
import com.example.ledger.util.AppLog
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.flow.Flow

sealed interface SaveResult {
    data class Saved(val id: Long) : SaveResult
    data class Failed(val cause: Throwable) : SaveResult
}

@Singleton
class TransactionRepository @Inject constructor(
    private val dao: TransactionDao,
    private val rates: RatesApi,
) {
    fun observe(): Flow<List<Transaction>> = dao.observeAll()

    suspend fun add(transaction: Transaction): SaveResult =
        try {
            SaveResult.Saved(dao.insert(transaction))
        } catch (e: SQLiteException) {
            AppLog.w("insert failed", e)
            SaveResult.Failed(e)
        }

    /**
     * Rates are a convenience, not a source of truth: when the call fails we
     * return null and the UI shows original currencies with a stale banner,
     * instead of converting with numbers we cannot vouch for.
     */
    suspend fun latestRate(from: String, to: String): Double? =
        runCatching { rates.latest(from).rates[to] }
            .onFailure { AppLog.w("rates unavailable", it) }
            .getOrNull()
}
