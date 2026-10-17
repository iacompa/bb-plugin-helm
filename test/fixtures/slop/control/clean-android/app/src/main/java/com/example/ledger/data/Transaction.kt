package com.example.ledger.data

import androidx.room.Entity
import androidx.room.PrimaryKey

@Entity(tableName = "transactions")
data class Transaction(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val description: String,
    val amountMinor: Long,
    val currency: String,
    val bookedAtEpochDay: Long,
)
