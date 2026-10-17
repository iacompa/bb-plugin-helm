package com.example.ledger

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.example.ledger.data.Transaction
import com.example.ledger.ui.TransactionRow
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class TransactionRowTest {
    @get:Rule val compose = createComposeRule()

    @Test
    fun clickInvokesCallback() {
        var clicked = false
        val mock = Transaction(id = 1, description = "Rent", amountMinor = 95_000, currency = "EUR", bookedAtEpochDay = 20_000)
        compose.setContent { TransactionRow(mock, onClick = { clicked = true }) }
        compose.onNodeWithText("Rent").performClick()
        assertTrue(clicked)
    }
}
