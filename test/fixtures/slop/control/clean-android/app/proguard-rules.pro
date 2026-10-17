# kotlinx.serialization keeps generated serializers via its own consumer rules;
# Retrofit's service interfaces need their generic signatures kept.
-keepattributes Signature, InnerClasses, EnclosingMethod
-keep,allowobfuscation,allowshrinking interface retrofit2.Call
