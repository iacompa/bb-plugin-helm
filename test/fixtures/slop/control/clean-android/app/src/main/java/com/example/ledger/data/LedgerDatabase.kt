package com.example.ledger.data

import androidx.room.Database
import androidx.room.RoomDatabase

@Database(entities = [Transaction::class], version = 2, exportSchema = true)
abstract class LedgerDatabase : RoomDatabase() {
    abstract fun transactions(): TransactionDao
}
