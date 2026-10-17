package com.example.ledger

import com.example.ledger.data.Transaction
import com.example.ledger.data.TransactionDao
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.map

class FakeTransactionDao(private val failInserts: Boolean = false) : TransactionDao {
    private val rows = MutableStateFlow<List<Transaction>>(emptyList())

    override fun observeAll(): Flow<List<Transaction>> = rows

    override suspend fun insert(transaction: Transaction): Long {
        if (failInserts) throw android.database.sqlite.SQLiteException("disk full")
        val id = rows.value.size + 1L
        rows.value = rows.value + transaction.copy(id = id)
        return id
    }

    override fun search(query: String): Flow<List<Transaction>> =
        rows.map { list -> list.filter { query in it.description } }
}
