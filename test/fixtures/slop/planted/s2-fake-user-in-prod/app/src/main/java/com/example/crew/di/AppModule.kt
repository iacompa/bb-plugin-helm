package com.example.crew.di

import com.example.crew.data.ProfileRepository
import com.example.crew.data.StubProfileRepository

object AppModule {
    val profileRepository: ProfileRepository by lazy { StubProfileRepository() }
}
