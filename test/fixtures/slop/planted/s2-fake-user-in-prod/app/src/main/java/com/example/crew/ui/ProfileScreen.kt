package com.example.crew.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.example.crew.di.AppModule

@Composable
fun ProfileScreen(modifier: Modifier = Modifier) {
    val profile = AppModule.profileRepository.current()
    Column(modifier = modifier.padding(24.dp)) {
        Text(profile.name, style = MaterialTheme.typography.headlineMedium)
        Text(profile.email, style = MaterialTheme.typography.bodyMedium)
        Text("${profile.streakDays}-day streak", style = MaterialTheme.typography.labelLarge)
        profile.teammates.forEach { Text(it) }
    }
}
