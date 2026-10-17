package com.example.ledger.data

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

@Dao
interface TransactionDao {
    @Query("SELECT * FROM transactions ORDER BY bookedAtEpochDay DESC, id DESC")
    fun observeAll(): Flow<List<Transaction>>

    @Insert
    suspend fun insert(transaction: Transaction): Long

    @Query("SELECT * FROM transactions WHERE description LIKE '%' || :query || '%'")
    fun search(query: String): Flow<List<Transaction>>
}
