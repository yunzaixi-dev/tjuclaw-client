package cn.edu.tju.tjuclaw

import android.os.Bundle
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val safe = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      view.setPadding(safe.left, safe.top, safe.right, maxOf(safe.bottom, ime.bottom))
      // The WebView now fits the unobscured content area. Do not apply system
      // safe areas or the IME a second time inside the web page.
      WindowInsetsCompat.CONSUMED
    }
    ViewCompat.requestApplyInsets(content)
  }
}
