package com.example.ledger.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.example.ledger.R
import com.example.ledger.data.Transaction
import java.text.NumberFormat
import java.util.Currency

@Composable
fun TransactionListScreen(viewModel: TransactionListViewModel = hiltViewModel()) {
    val transactions by viewModel.transactions.collectAsStateWithLifecycle()
    if (transactions.isEmpty()) {
        Column(Modifier.padding(24.dp)) {
            Text(stringResource(R.string.empty_title), style = MaterialTheme.typography.titleMedium)
            Text(stringResource(R.string.empty_body), style = MaterialTheme.typography.bodyMedium)
        }
    } else {
        LazyColumn {
            items(transactions, key = { it.id }) { t -> TransactionRow(t, onClick = { viewModel.select(t) }) }
        }
    }
}

@Composable
fun TransactionRow(transaction: Transaction, onClick: () -> Unit) {
    val format = NumberFormat.getCurrencyInstance().apply { currency = Currency.getInstance(transaction.currency) }
    ListItem(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
        headlineContent = { Text(transaction.description) },
        trailingContent = { Text(format.format(transaction.amountMinor / 100.0)) },
    )
}

@Preview(showBackground = true)
@Composable
private fun TransactionRowPreview() {
    TransactionRow(
        Transaction(id = 1, description = "Groceries — Markthalle", amountMinor = 2_340, currency = "EUR", bookedAtEpochDay = 20_000),
        onClick = {},
    )
}
