using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using Ellipse = System.Windows.Shapes.Ellipse;
using Shape = System.Windows.Shapes.Shape;
using Forms = System.Windows.Forms;
using MediaBrush = System.Windows.Media.Brush;
using MediaColor = System.Windows.Media.Color;

namespace LocalMcpStudio
{
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            System.Windows.Media.RenderOptions.ProcessRenderMode = System.Windows.Interop.RenderMode.SoftwareOnly;
            bool created;
#if LOCALMCP_PREVIEW
            const string mutexName = "Local\\LocalMcpStudio.Native.Preview";
#else
            const string mutexName = "Local\\LocalMcpStudio.Native";
#endif
            using (var mutex = new Mutex(true, mutexName, out created))
            {
                if (!created) return;
                try
                {
                    var app = new Application { ShutdownMode = ShutdownMode.OnMainWindowClose };
                    app.Run(new MainWindow());
                }
                finally { mutex.ReleaseMutex(); }
            }
        }
    }

    internal sealed class MainWindow : Window
    {
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 4 * 1024 * 1024 };
        private readonly HttpClient _http = new HttpClient { Timeout = TimeSpan.FromSeconds(35) };
        private readonly string _root = ResolveRoot();
        private Process _backend;
        private string _baseUrl = "http://127.0.0.1:43127";
        private bool _refreshing, _binding, _serverLoaded, _closing;
        private bool _shutdownComplete;
        private DispatcherTimer _timer, _toastTimer;

        private TextBox _project, _mcpUrl, _serverHost, _serverPort, _serverUser, _serverUrl, _fingerprint, _publicKey;
        private TextBlock _status, _actionHint, _serverHint, _toast, _toolList;
        private StackPanel _logList, _permissionOptions, _connectionOptions;
        private Border _serverFields, _toastHost;
        private Border _devWarning;
        private Button _connect, _stop, _copyUrl, _resetLink, _saveServer, _clearLogs;
        private string _permission = "dev", _connectionMode = "quick", _publicKeyValue = "";

        internal MainWindow()
        {
            Title = "Local MCP Studio";
            Width = 1500; Height = 980; MinWidth = 920; MinHeight = 680;
            WindowStartupLocation = WindowStartupLocation.CenterScreen;
            WindowState = WindowState.Maximized;
            Background = Brush("#F5F7FC");
            FontFamily = SystemFonts.MessageFontFamily;
            FontSize = 17;
            TrySetIcon();
            BuildUi();
            Loaded += async (s, e) => { await StartBackend(); await Refresh(); StartTimer(); };
            Closing += OnClosing;
        }

        private static MediaBrush Brush(string value) { return (MediaBrush)new BrushConverter().ConvertFromString(value); }
        private static MediaColor Color(string value) { return (MediaColor)ColorConverter.ConvertFromString(value); }
        private object ButtonLabel(string text, string icon, MediaBrush foreground)
        {
            var contentStack = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
            var glyph = IconPath(icon, foreground, 17); glyph.Margin = new Thickness(0, 0, 9, 0); contentStack.Children.Add(glyph);
            contentStack.Children.Add(new TextBlock { Text = text, VerticalAlignment = VerticalAlignment.Center });
            return contentStack;
        }
        private static string ResolveRoot()
        {
            string folder = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
            if (File.Exists(Path.Combine(folder, "src", "main.js"))) return folder;
            DirectoryInfo parent = Directory.GetParent(folder);
            return parent != null && File.Exists(Path.Combine(parent.FullName, "src", "main.js")) ? parent.FullName : folder;
        }
        private static System.Windows.Shapes.Path IconPath(string name, MediaBrush fill, double size)
        {
            var geometry = new GeometryGroup { FillRule = FillRule.EvenOdd };
            Action<string> add = d => geometry.Children.Add(Geometry.Parse(d));
            Action<double, double, double, double> ellipse = (x, y, rx, ry) => geometry.Children.Add(new EllipseGeometry(new Point(x, y), rx, ry));
            Action<double, double, double, double, double> rounded = (x, y, w, h, r) => geometry.Children.Add(new RectangleGeometry(new Rect(x, y, w, h), r, r));
            switch (name)
            {
                case "folder": add("M3.5,8 C3.5,6.9 4.4,6 5.5,6 H9.5 L11.5,8 H18.5 C19.6,8 20.5,8.9 20.5,10 V17.5 C20.5,18.6 19.6,19.5 18.5,19.5 H5.5 C4.4,19.5 3.5,18.6 3.5,17.5 Z M3.5,9.5 H20.5"); break;
                case "folder-plus": add("M3.5,8 C3.5,6.9 4.4,6 5.5,6 H9.5 L11.5,8 H18.5 C19.6,8 20.5,8.9 20.5,10 V17.5 C20.5,18.6 19.6,19.5 18.5,19.5 H5.5 C4.4,19.5 3.5,18.6 3.5,17.5 Z M3.5,9.5 H20.5 M12,12 V17 M9.5,14.5 H14.5"); break;
                case "search": ellipse(10.5, 10.5, 6.1, 6.1); add("M15,15 L20,20"); break;
                case "pencil": add("M4.5,19.5 L8.5,18.6 L19,8.2 C20.3,6.9 18.1,4.7 16.8,6 L6.4,16.4 Z M14.8,8 L17.5,10.7"); break;
                case "terminal": rounded(3.5, 4.5, 17, 15, 2.3); add("M7.5,9 L10.5,11.7 L7.5,14.5 M13,14.5 H16.5"); break;
                case "alert": add("M10.3,4.7 C11.1,3.3 12.9,3.3 13.7,4.7 L20.7,16.9 C21.5,18.3 20.5,20 18.8,20 H5.2 C3.5,20 2.5,18.3 3.3,16.9 Z M12,8.5 V13 M12,16.5 V16.6"); break;
                case "info": ellipse(12, 12, 9, 9); add("M12,11 V16 M12,7.5 V7.6"); break;
                case "arrow-up-right": add("M7,17 L17,7 M8,7 H17 V16"); break;
                case "external-link": add("M13,5 H19 V11 M18.5,5.5 L11,13 M18,13.5 V17.5 C18,18.3 17.3,19 16.5,19 H6.5 C5.7,19 5,18.3 5,17.5 V7.5 C5,6.7 5.7,6 6.5,6 H10.5"); break;
                case "stop": rounded(6, 6, 12, 12, 2); break;
                case "lock": rounded(4.5, 10, 15, 10, 2); add("M8,10 V7 A4,4 0 0,1 16,7 V10 M12,14 V16.5"); break;
                case "copy": rounded(8, 8, 11, 12, 2); add("M15.5,8 V6 A2,2 0 0,0 13.5,4 H6.5 A2,2 0 0,0 4.5,6 V15 A2,2 0 0,0 6.5,17 H8"); break;
                case "shield": add("M12,3.5 L19,6 V11.2 C19,15.6 16.3,18.7 12,20.5 C7.7,18.7 5,15.6 5,11.2 V6 Z"); break;
                case "shield-alert": add("M12,3.5 L19,6 V11.2 C19,15.6 16.3,18.7 12,20.5 C7.7,18.7 5,15.6 5,11.2 V6 Z M12,8 V12 M12,15 V15.1"); break;
                case "shield-check": add("M12,3.5 L19,6 V11.2 C19,15.6 16.3,18.7 12,20.5 C7.7,18.7 5,15.6 5,11.2 V6 Z M8.7,12 L10.9,14.2 L15.4,9.6"); break;
                case "refresh": add("M20,7 V12 H15 M4,17 V12 H9 M5.7,9 A7,7 0 0,1 17.5,7 L20,12 M4,12 L6.5,17 A7,7 0 0,0 18.3,15"); break;
                case "check": add("M5,12.5 L9.5,17 L19,7.5"); break;
                case "paw": ellipse(12, 15.5, 5.1, 4.1); ellipse(5.8, 10.5, 1.7, 2.2); ellipse(10, 7.6, 1.7, 2.2); ellipse(14.4, 7.6, 1.7, 2.2); ellipse(18.2, 10.5, 1.7, 2.2); break;
                case "cloud": add("M6,19 C2.7,19 1,16.8 1,14 C1,11.2 3.1,9 6,9 C7,5.8 9.7,4 13,4 C16.7,4 19,6.7 19,10 C21.6,10 23,11.8 23,14.5 C23,17.2 21.2,19 18,19 Z"); break;
                case "link": add("M9.5,14.5 L14.5,9.5 M8,16 L6.4,17.6 C4.7,19.3 2,19.3 2,16.6 C2,15.5 2.5,14.6 3.3,13.8 L7,10.1 C8.7,8.4 11.4,8.4 13.1,10.1 M16,8 L17.6,6.4 C19.3,4.7 22,4.7 22,7.4 C22,8.5 21.5,9.4 20.7,10.2 L17,13.9 C15.3,15.6 12.6,15.6 10.9,13.9"); break;
                case "key": ellipse(8, 9, 4.5, 4.5); add("M11.2,12.2 L20,21 M16,17 L18,15 M18,19 L20,17"); break;
                case "server": rounded(3.5, 4, 17, 7, 2); rounded(3.5, 13, 17, 7, 2); ellipse(7, 7.5, .7, .7); ellipse(7, 16.5, .7, .7); add("M10,7.5 H17 M10,16.5 H17"); break;
                case "save": add("M4,4 H17 L20,7 V20 H4 Z M8,4 V10 H16 V4 M8,20 V14 H16 V20"); break;
                case "activity": add("M3,12 H7 L10,6 L14,18 L17,12 H21"); break;
                case "trash": rounded(5, 7, 14, 14, 2); add("M3.5,7 H20.5 M9,7 V4.5 H15 V7 M9,10.5 V17 M15,10.5 V17"); break;
                case "spark": add("M12,2 L14,9 L21,12 L14,14 L12,22 L10,14 L3,12 L10,9 Z M19,2 V6 M17,4 H21"); break;
                default: ellipse(12, 15.5, 5.1, 4.1); ellipse(5.8, 10.5, 1.7, 2.2); ellipse(10, 7.6, 1.7, 2.2); ellipse(14.4, 7.6, 1.7, 2.2); ellipse(18.2, 10.5, 1.7, 2.2); break;
            }
            return new System.Windows.Shapes.Path { Data = geometry, Fill = Brushes.Transparent, Stroke = fill, StrokeThickness = 1.7, StrokeStartLineCap = PenLineCap.Round, StrokeEndLineCap = PenLineCap.Round, StrokeLineJoin = PenLineJoin.Round, Width = size, Height = size, Stretch = Stretch.Uniform, VerticalAlignment = VerticalAlignment.Center };
        }
        private void TrySetIcon()
        {
            try { Icon = BitmapFrame.Create(new Uri(Path.Combine(_root, "assets", "app.ico"), UriKind.Absolute)); } catch { }
        }

        private void BuildUi()
        {
            var outer = new DockPanel();
            var header = new Border { Background = Brush("#FFFFFF"), BorderBrush = Brush("#E3E9F3"), BorderThickness = new Thickness(0, 0, 0, 1), Padding = new Thickness(28, 16, 30, 16) };
            DockPanel.SetDock(header, Dock.Top);
            var head = new Grid(); head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto }); head.ColumnDefinitions.Add(new ColumnDefinition()); head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            var brand = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
            var badge = new Border { Width = 48, Height = 48, CornerRadius = new CornerRadius(15), Background = Brush("#EEF2FC"), Margin = new Thickness(0, 0, 14, 0), Child = new Image { Source = LoadBunnyImage(), Stretch = Stretch.Uniform, Margin = new Thickness(4) } };
            brand.Children.Add(badge);
            var brandCopy = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
            brandCopy.Children.Add(new TextBlock { Text = "Local MCP Studio", FontSize = 23, FontWeight = FontWeights.SemiBold, Foreground = Brush("#293750") });
            brandCopy.Children.Add(new TextBlock { Text = "本地项目桥接", FontSize = 15, Foreground = Brush("#697893"), Margin = new Thickness(0, 2, 0, 0) });
            brand.Children.Add(brandCopy); head.Children.Add(brand);
            _status = new TextBlock { Text = "本机待连接", FontSize = 16, FontWeight = FontWeights.SemiBold, Foreground = Brush("#53637D"), VerticalAlignment = VerticalAlignment.Center };
            var statusPill = new Border { Background = Brush("#EEF2FA"), CornerRadius = new CornerRadius(20), Padding = new Thickness(15, 9, 15, 9), Child = _status, VerticalAlignment = VerticalAlignment.Center };
            Grid.SetColumn(statusPill, 2); head.Children.Add(statusPill); header.Child = head; outer.Children.Add(header);

            var footer = new Border { Background = Brush("#FFFFFF"), BorderBrush = Brush("#E3E9F3"), BorderThickness = new Thickness(0, 1, 0, 0), Padding = new Thickness(28, 12, 28, 12) };
            DockPanel.SetDock(footer, Dock.Bottom);
            var ft = new Grid(); ft.ColumnDefinitions.Add(new ColumnDefinition()); ft.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            ft.Children.Add(new TextBlock { Text = "LOCAL MCP STUDIO   0.1.14", FontSize = 14, FontWeight = FontWeights.SemiBold, Foreground = Brush("#65738D") });
            var privacy = new TextBlock { Text = "PRIVATE BY DEFAULT  ·  SESSION SCOPED", FontSize = 14, Foreground = Brush("#7D8BA3"), HorizontalAlignment = HorizontalAlignment.Right };
            Grid.SetColumn(privacy, 1); ft.Children.Add(privacy); footer.Child = ft; outer.Children.Add(footer);

            var scroll = new ScrollViewer { VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled, Padding = new Thickness(28, 24, 28, 28) };
            var page = new Grid { MaxWidth = 1740, HorizontalAlignment = HorizontalAlignment.Stretch };
            page.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1.8, GridUnitType.Star) });
            page.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(32) });
            page.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star), MinWidth = 330 });
            page.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            page.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            page.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            page.SizeChanged += (s, e) => Reflow(page);

            var hero = new Border { Background = Brush("#EAF0FC"), BorderBrush = Brush("#DCE5F6"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(24), Padding = new Thickness(34, 28, 34, 28), Margin = new Thickness(0, 0, 0, 28), MinHeight = 178 };
            var heroGrid = new Grid(); heroGrid.ColumnDefinitions.Add(new ColumnDefinition()); heroGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(240) });
            var heroText = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
            heroText.Children.Add(new TextBlock { Text = "LOCAL MCP  ·  WINDOWS DESKTOP", FontSize = 14, FontWeight = FontWeights.Bold, Foreground = Brush("#7188B9"), Margin = new Thickness(0, 0, 0, 8) });
            heroText.Children.Add(new TextBlock { Text = "让 ChatGPT 走进你的项目。", FontSize = 34, FontWeight = FontWeights.SemiBold, Foreground = Brush("#2D3B57") });
            heroText.Children.Add(new TextBlock { Text = "选择一个本地目录，安全连接文件、Git 与开发工具。", FontSize = 18, Foreground = Brush("#5F708D"), Margin = new Thickness(0, 8, 0, 0) });
            heroGrid.Children.Add(heroText);
            var bunny = new Image { Source = LoadBunnyImage(), Width = 142, Height = 142, Stretch = Stretch.Uniform, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
            Grid.SetColumn(bunny, 1); heroGrid.Children.Add(bunny); hero.Child = heroGrid; Grid.SetColumnSpan(hero, 3); page.Children.Add(hero);

            var main = new StackPanel(); Grid.SetRow(main, 1); page.Children.Add(main);
            var side = new StackPanel(); Grid.SetColumn(side, 2); Grid.SetRow(side, 1); page.Children.Add(side);
            AddProjectCard(main);
            AddPermissionCard(main);
            AddConnectionCard(main);
            AddMainActions(main);
            AddEndpointCard(main);
            AddToolsCard(side);
            AddLogsCard(side);
            var localNote = new Border { Background = Brush("#EEF2FC"), CornerRadius = new CornerRadius(15), Padding = new Thickness(16), Child = IconNote("shield", "本机运行，按需传输\nMCP 请求经当前选择的公网转发链路传输。", Brush("#5F6F89"), 21, 16, new Thickness(0), 9) };
            side.Children.Add(localNote);
            scroll.Content = page; outer.Children.Add(scroll);

            _toast = new TextBlock { Foreground = Brushes.White, FontSize = 16, FontWeight = FontWeights.SemiBold, TextWrapping = TextWrapping.Wrap, TextAlignment = TextAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
            _toastHost = new Border { Background = Brush("#40577F"), CornerRadius = new CornerRadius(18), Padding = new Thickness(20, 12, 20, 12), Visibility = Visibility.Collapsed, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Bottom, Margin = new Thickness(24, 0, 24, 58), MaxWidth = 680, Child = _toast };
            Grid host = new Grid(); host.Children.Add(outer); host.Children.Add(_toastHost); Content = host;
        }

        private ImageSource LoadIconImage()
        {
            try { return BitmapFrame.Create(new Uri(Path.Combine(_root, "assets", "app.ico"), UriKind.Absolute)); } catch { return null; }
        }
        private ImageSource LoadBunnyImage()
        {
            try { var image = new BitmapImage(); image.BeginInit(); image.UriSource = new Uri(Path.Combine(_root, "assets", "lilac-bunny.png"), UriKind.Absolute); image.CacheOption = BitmapCacheOption.OnLoad; image.EndInit(); return image; } catch { return LoadIconImage(); }
        }

        private void Reflow(Grid page)
        {
            var scroll = page.Parent as ScrollViewer;
            double width = page.ActualWidth;
            if (scroll != null && scroll.ActualWidth > 0)
                width = Math.Min(1740, Math.Max(0, scroll.ActualWidth - scroll.Padding.Left - scroll.Padding.Right - 18));
            if (width > 0 && (Double.IsNaN(page.Width) || Math.Abs(page.Width - width) > 1)) page.Width = width;
            if ((width > 0 ? width : page.ActualWidth) < 1500)
            {
                page.ColumnDefinitions[0].Width = new GridLength(1, GridUnitType.Star);
                page.ColumnDefinitions[1].Width = new GridLength(0);
                page.ColumnDefinitions[2].Width = new GridLength(0);
                foreach (UIElement child in page.Children)
                {
                    if (child == null || child == page.Children[0]) continue;
                    if (Grid.GetColumn(child) == 2) { Grid.SetColumn(child, 0); Grid.SetRow(child, 2); }
                }
            }
            else
            {
                page.ColumnDefinitions[0].Width = new GridLength(1.8, GridUnitType.Star);
            page.ColumnDefinitions[1].Width = new GridLength(32);
                page.ColumnDefinitions[2].Width = new GridLength(1, GridUnitType.Star);
                foreach (UIElement child in page.Children)
                {
                    if (child == null || child == page.Children[0]) continue;
                    if (Grid.GetRow(child) == 2) { Grid.SetColumn(child, 2); Grid.SetRow(child, 1); }
                }
            }
        }

        private Border Card(string title, string subtitle, string icon = null)
        {
            var stack = new StackPanel();
            var head = new DockPanel { Margin = new Thickness(0, 0, 0, 23) };
            if (icon != null)
            {
                var n = new Border { Background = Brush("#EEF2FC"), CornerRadius = new CornerRadius(13), Width = 44, Height = 44, Margin = new Thickness(0, 0, 16, 0), Child = IconPath(icon, Brush("#7188B9"), 21) };
                head.Children.Add(n);
            }
            var words = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
            words.Children.Add(new TextBlock { Text = title, FontSize = 20, FontWeight = FontWeights.SemiBold, Foreground = Brush("#2D3A54") });
            words.Children.Add(new TextBlock { Text = subtitle, FontSize = 15, Foreground = Brush("#718099"), Margin = new Thickness(0, 5, 0, 0), TextWrapping = TextWrapping.Wrap });
            head.Children.Add(words); stack.Children.Add(head);
            return new Border { Background = Brush("#FFFFFF"), BorderBrush = Brush("#E3E9F2"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(22), Padding = new Thickness(26), Margin = new Thickness(0, 0, 0, 22), Child = stack, Tag = stack };
        }

        private StackPanel Body(Border card) { return (StackPanel)card.Tag; }
        private TextBlock Label(string text) { return new TextBlock { Text = text, FontSize = 15, FontWeight = FontWeights.SemiBold, Foreground = Brush("#52617B"), Margin = new Thickness(0, 12, 0, 7) }; }
        private Grid IconNote(string icon, string message, MediaBrush foreground, double iconSize, double fontSize, Thickness margin, double gap)
        {
            var note = new Grid { Margin = margin };
            note.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            note.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            var glyph = IconPath(icon, foreground, iconSize); glyph.Margin = new Thickness(0, 0, gap, 0); glyph.VerticalAlignment = VerticalAlignment.Center; Grid.SetColumn(glyph, 0); note.Children.Add(glyph);
            var copy = new TextBlock { Text = message, Foreground = foreground, FontSize = fontSize, TextWrapping = TextWrapping.Wrap, VerticalAlignment = VerticalAlignment.Center }; Grid.SetColumn(copy, 1); note.Children.Add(copy);
            return note;
        }
        private TextBox Input(string hint = "")
        {
            var box = new TextBox { Height = 52, FontSize = 16, Padding = new Thickness(12, 0, 12, 0), BorderBrush = Brush("#CCD6E7"), BorderThickness = new Thickness(1), Background = Brushes.White, Foreground = Brush("#2C3A54"), VerticalContentAlignment = VerticalAlignment.Center, ToolTip = hint };
            var template = new ControlTemplate(typeof(TextBox));
            var border = new FrameworkElementFactory(typeof(Border)); border.Name = "InputBorder";
            border.SetValue(Border.CornerRadiusProperty, new CornerRadius(11));
            border.SetBinding(Border.BackgroundProperty, new System.Windows.Data.Binding("Background") { RelativeSource = new System.Windows.Data.RelativeSource(System.Windows.Data.RelativeSourceMode.TemplatedParent) });
            border.SetBinding(Border.BorderBrushProperty, new System.Windows.Data.Binding("BorderBrush") { RelativeSource = new System.Windows.Data.RelativeSource(System.Windows.Data.RelativeSourceMode.TemplatedParent) });
            border.SetBinding(Border.BorderThicknessProperty, new System.Windows.Data.Binding("BorderThickness") { RelativeSource = new System.Windows.Data.RelativeSource(System.Windows.Data.RelativeSourceMode.TemplatedParent) });
            var content = new FrameworkElementFactory(typeof(ScrollViewer)); content.Name = "PART_ContentHost";
            content.SetBinding(FrameworkElement.MarginProperty, new System.Windows.Data.Binding("Padding") { RelativeSource = new System.Windows.Data.RelativeSource(System.Windows.Data.RelativeSourceMode.TemplatedParent) });
            content.SetBinding(ScrollViewer.VerticalContentAlignmentProperty, new System.Windows.Data.Binding("VerticalContentAlignment") { RelativeSource = new System.Windows.Data.RelativeSource(System.Windows.Data.RelativeSourceMode.TemplatedParent) });
            content.SetBinding(ScrollViewer.HorizontalContentAlignmentProperty, new System.Windows.Data.Binding("HorizontalContentAlignment") { RelativeSource = new System.Windows.Data.RelativeSource(System.Windows.Data.RelativeSourceMode.TemplatedParent) });
            content.SetValue(ScrollViewer.FocusableProperty, false); content.SetValue(ScrollViewer.BackgroundProperty, Brushes.Transparent);
            content.SetValue(ScrollViewer.CanContentScrollProperty, false); content.SetValue(ScrollViewer.VerticalScrollBarVisibilityProperty, ScrollBarVisibility.Hidden); content.SetValue(ScrollViewer.HorizontalScrollBarVisibilityProperty, ScrollBarVisibility.Auto);
            border.AppendChild(content); template.VisualTree = border;
            var focus = new Trigger { Property = UIElement.IsKeyboardFocusedProperty, Value = true };
            focus.Setters.Add(new Setter(Border.BorderBrushProperty, Brush("#A8BDE2"), "InputBorder"));
            template.Triggers.Add(focus); box.Template = template;
            return box;
        }
        private Button Btn(string text, Action action, bool primary = false, bool danger = false, string icon = null)
        {
            var foreground = Brush(primary ? "#FFFFFF" : danger ? "#B65F6D" : "#7188B9");
            object content = icon == null ? (object)text : ButtonLabel(text, icon, foreground);
            var b = new Button { Content = content, FontSize = 16, FontWeight = FontWeights.SemiBold, Padding = new Thickness(19, 11, 19, 11), Margin = new Thickness(0, 0, 10, 0), MinHeight = 50, Cursor = Cursors.Hand, BorderThickness = new Thickness(1), BorderBrush = Brush(primary ? "#7188B9" : danger ? "#E9C4CD" : "#DDE4EF"), Background = Brush(primary ? "#7188B9" : danger ? "#FFF2F5" : "#F8FAFE"), Foreground = Brush(primary ? "#FFFFFF" : danger ? "#B65F6D" : "#45546F") };
            var template = new ControlTemplate(typeof(Button));
            var border = new FrameworkElementFactory(typeof(Border));
            border.SetValue(Border.CornerRadiusProperty, new CornerRadius(12));
            border.SetBinding(Border.BackgroundProperty, new System.Windows.Data.Binding("Background") { RelativeSource = new System.Windows.Data.RelativeSource(System.Windows.Data.RelativeSourceMode.TemplatedParent) });
            border.SetBinding(Border.BorderBrushProperty, new System.Windows.Data.Binding("BorderBrush") { RelativeSource = new System.Windows.Data.RelativeSource(System.Windows.Data.RelativeSourceMode.TemplatedParent) });
            border.SetBinding(Border.BorderThicknessProperty, new System.Windows.Data.Binding("BorderThickness") { RelativeSource = new System.Windows.Data.RelativeSource(System.Windows.Data.RelativeSourceMode.TemplatedParent) });
            var presenter = new FrameworkElementFactory(typeof(ContentPresenter));
            presenter.SetValue(ContentPresenter.HorizontalAlignmentProperty, HorizontalAlignment.Center);
            presenter.SetValue(ContentPresenter.VerticalAlignmentProperty, VerticalAlignment.Center);
            presenter.SetValue(ContentPresenter.MarginProperty, new TemplateBindingExtension(Control.PaddingProperty));
            border.AppendChild(presenter); template.VisualTree = border; b.Template = template;
            b.Click += (s, e) => action();
            return b;
        }

        private void AddProjectCard(Panel target)
        {
            var card = Card("选择项目目录", "只开放这个文件夹给本次 MCP 会话", "folder");
            var row = new DockPanel { LastChildFill = true }; _project = Input("选择一个项目文件夹"); _project.Margin = new Thickness(0, 0, 12, 0);
            var browse = Btn("浏览文件夹", () => BrowseFolder(), icon: "folder-plus"); DockPanel.SetDock(browse, Dock.Right); row.Children.Add(browse); row.Children.Add(_project); Body(card).Children.Add(row);
            Body(card).Children.Add(IconNote("check", "路径设置保留在本机。文件内容只会在工具调用时传输。", Brush("#6E7B93"), 16, 15, new Thickness(2, 16, 0, 0), 7));
            target.Children.Add(card);
        }
        private void AddPermissionCard(Panel target)
        {
            var card = Card("设置会话权限", "按任务需要选择开放给 ChatGPT 的工具", "shield-check");
            _permissionOptions = new StackPanel();
            AddRadioOption(_permissionOptions, "只读审阅", "读取、搜索与查看 Git", "read", "READ", "#EAF0FC");
            AddRadioOption(_permissionOptions, "允许编辑", "在只读基础上修改文件", "edit", "WRITE", "#FCEBF0");
            AddRadioOption(_permissionOptions, "开发模式", "命令、长任务、Git 提交与完整 REA 逆向工具", "dev", "DEV", "#EEF2FC");
            Body(card).Children.Add(_permissionOptions);
            var devNote = IconNote("alert", "开发模式会开放 229 项 REA MCP 工具，并以当前 Windows 用户权限执行。REA 工具按照请求中指定的目标运行，可能涉及程序运行时操作；请只连接可信的 ChatGPT MCP 会话并指定可信目标。", Brush("#A45D6D"), 17, 15, new Thickness(0, 12, 0, 0), 8);
            _devWarning = new Border { Background = Brush("#FFF2F5"), CornerRadius = new CornerRadius(10), Padding = new Thickness(13), Child = devNote };
            Body(card).Children.Add(_devWarning);
            target.Children.Add(card);
        }

        private void AddRadioOption(Panel panel, string title, string detail, string value, string tag, string color)
        {
            var rb = new RadioButton { GroupName = "permission", Tag = value, IsChecked = value == "dev", Margin = new Thickness(0, 0, 0, 10), Padding = new Thickness(8), FontSize = 16, HorizontalContentAlignment = HorizontalAlignment.Stretch, VerticalContentAlignment = VerticalAlignment.Center };
            ApplyRadioTemplate(rb);
            var line = new DockPanel();
            var chip = new Border { Background = Brush(color), CornerRadius = new CornerRadius(8), Padding = new Thickness(8, 5, 8, 5), Child = new TextBlock { Text = tag, FontSize = 12, FontWeight = FontWeights.Bold, Foreground = Brush("#60769F") } };
            DockPanel.SetDock(chip, Dock.Right); line.Children.Add(chip);
            var mark = new Border { Width = 38, Height = 38, CornerRadius = new CornerRadius(11), Background = Brush(color), Margin = new Thickness(0, 0, 13, 0), Child = IconPath(value == "read" ? "search" : value == "edit" ? "pencil" : "terminal", Brush(value == "edit" ? "#CE7893" : "#7188B9"), 19) };
            DockPanel.SetDock(mark, Dock.Left); line.Children.Add(mark);
            var text = new StackPanel { Margin = new Thickness(0, 0, 10, 0) }; text.Children.Add(new TextBlock { Text = title, FontWeight = FontWeights.SemiBold, FontSize = 16, Foreground = Brush("#32415D"), TextWrapping = TextWrapping.Wrap }); text.Children.Add(new TextBlock { Text = detail, FontSize = 14, Foreground = Brush("#72809B"), Margin = new Thickness(0, 2, 0, 0), TextWrapping = TextWrapping.Wrap });
            line.Children.Add(text); rb.Content = line;
            rb.Checked += async (s, e) => { if (_binding) return; _permission = value; UpdateDevNotice(); try { await Post("/api/permission", new Dictionary<string, object> { { "permission", value } }); } catch (Exception ex) { Toast(ex.Message); } };
            panel.Children.Add(rb);
        }

        private void ApplyRadioTemplate(RadioButton rb)
        {
            var template = new ControlTemplate(typeof(RadioButton));
            var surface = new FrameworkElementFactory(typeof(Border)); surface.Name = "OptionSurface";
            surface.SetValue(Border.CornerRadiusProperty, new CornerRadius(13));
            surface.SetValue(Border.BackgroundProperty, Brushes.Transparent);
            surface.SetValue(Border.BorderBrushProperty, Brushes.Transparent);
            surface.SetValue(Border.BorderThicknessProperty, new Thickness(1));
            surface.SetValue(Border.PaddingProperty, new TemplateBindingExtension(Control.PaddingProperty));
            var row = new FrameworkElementFactory(typeof(DockPanel)); row.SetValue(DockPanel.LastChildFillProperty, true);
            var indicator = new FrameworkElementFactory(typeof(Grid)); indicator.SetValue(FrameworkElement.WidthProperty, 22d); indicator.SetValue(FrameworkElement.HeightProperty, 22d); indicator.SetValue(FrameworkElement.MarginProperty, new Thickness(0, 0, 12, 0)); indicator.SetValue(FrameworkElement.VerticalAlignmentProperty, VerticalAlignment.Center);
            var ring = new FrameworkElementFactory(typeof(Ellipse)); ring.Name = "RadioRing"; ring.SetValue(FrameworkElement.WidthProperty, 18d); ring.SetValue(FrameworkElement.HeightProperty, 18d); ring.SetValue(Shape.StrokeProperty, Brush("#9BA8BC")); ring.SetValue(Shape.StrokeThicknessProperty, 1.5); ring.SetValue(Shape.FillProperty, Brushes.White); ring.SetValue(FrameworkElement.HorizontalAlignmentProperty, HorizontalAlignment.Center); ring.SetValue(FrameworkElement.VerticalAlignmentProperty, VerticalAlignment.Center);
            var dot = new FrameworkElementFactory(typeof(Ellipse)); dot.Name = "RadioDot"; dot.SetValue(FrameworkElement.WidthProperty, 8d); dot.SetValue(FrameworkElement.HeightProperty, 8d); dot.SetValue(Shape.FillProperty, Brush("#7188B9")); dot.SetValue(UIElement.VisibilityProperty, Visibility.Collapsed); dot.SetValue(FrameworkElement.HorizontalAlignmentProperty, HorizontalAlignment.Center); dot.SetValue(FrameworkElement.VerticalAlignmentProperty, VerticalAlignment.Center);
            indicator.AppendChild(ring); indicator.AppendChild(dot); row.AppendChild(indicator);
            var presenter = new FrameworkElementFactory(typeof(ContentPresenter)); presenter.SetValue(ContentPresenter.HorizontalAlignmentProperty, HorizontalAlignment.Stretch); presenter.SetValue(ContentPresenter.VerticalAlignmentProperty, VerticalAlignment.Center); presenter.SetValue(ContentPresenter.RecognizesAccessKeyProperty, true);
            presenter.SetValue(ContentPresenter.ContentProperty, new TemplateBindingExtension(ContentControl.ContentProperty)); presenter.SetValue(ContentPresenter.ContentTemplateProperty, new TemplateBindingExtension(ContentControl.ContentTemplateProperty)); presenter.SetValue(ContentPresenter.ContentTemplateSelectorProperty, new TemplateBindingExtension(ContentControl.ContentTemplateSelectorProperty)); presenter.SetValue(ContentPresenter.ContentStringFormatProperty, new TemplateBindingExtension(ContentControl.ContentStringFormatProperty));
            row.AppendChild(presenter); surface.AppendChild(row); template.VisualTree = surface;
            var checkedTrigger = new Trigger { Property = ToggleButton.IsCheckedProperty, Value = true }; checkedTrigger.Setters.Add(new Setter(UIElement.VisibilityProperty, Visibility.Visible, "RadioDot")); checkedTrigger.Setters.Add(new Setter(Shape.StrokeProperty, Brush("#7188B9"), "RadioRing")); checkedTrigger.Setters.Add(new Setter(Border.BackgroundProperty, Brush("#F7F9FD"), "OptionSurface")); checkedTrigger.Setters.Add(new Setter(Border.BorderBrushProperty, Brush("#E3E9F2"), "OptionSurface")); template.Triggers.Add(checkedTrigger);
            var hoverTrigger = new Trigger { Property = UIElement.IsMouseOverProperty, Value = true }; hoverTrigger.Setters.Add(new Setter(Border.BackgroundProperty, Brush("#FAFBFE"), "OptionSurface")); template.Triggers.Add(hoverTrigger);
            var focusTrigger = new Trigger { Property = UIElement.IsKeyboardFocusedProperty, Value = true }; focusTrigger.Setters.Add(new Setter(Border.BorderBrushProperty, Brush("#A8BDE2"), "OptionSurface")); template.Triggers.Add(focusTrigger);
            rb.Template = template;
        }

        private void UpdateDevNotice()
        {
            if (_devWarning != null) _devWarning.Visibility = _permission == "dev" ? Visibility.Visible : Visibility.Collapsed;
        }

        private void AddConnectionCard(Panel target)
        {
            var card = Card("选择公网连接方式", "固定地址由你的服务器提供，重启后沿用同一个 MCP 地址", "cloud");
            _connectionOptions = new StackPanel();
            AddConnectionRadio("临时 HTTPS 地址", "无需配置服务器；每次连接会生成新地址", "quick", "QUICK");
            AddConnectionRadio("自有服务器固定地址", "通过 SSH 反向转发复用同一个 HTTPS 地址", "selfHosted", "STABLE");
            Body(card).Children.Add(_connectionOptions);
            _serverFields = new Border { Background = Brush("#F4F7FD"), BorderBrush = Brush("#E1E8F4"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(15), Padding = new Thickness(18), Margin = new Thickness(0, 14, 0, 0), Visibility = Visibility.Collapsed };
            var fields = new StackPanel();
            _serverHost = Input("服务器 IP 或主机名"); _serverUrl = Input("https://mcp.example.com"); _serverUser = Input("SSH 用户"); _serverPort = Input("SSH 端口"); _fingerprint = Input("SHA256 主机指纹");
            fields.Children.Add(Label("SSH 服务器")); fields.Children.Add(_serverHost); fields.Children.Add(Label("HTTPS 公网地址")); fields.Children.Add(_serverUrl);
            fields.Children.Add(Label("SSH 用户")); fields.Children.Add(_serverUser); fields.Children.Add(Label("SSH 端口")); fields.Children.Add(_serverPort);
            fields.Children.Add(Label("SSH 主机指纹"));
            _serverHost.Margin = new Thickness(0, 0, 0, 13); _serverUrl.Margin = new Thickness(0, 0, 0, 13); _serverUser.Margin = new Thickness(0, 0, 0, 13); _serverPort.Margin = new Thickness(0, 0, 0, 13);
            var frow = new DockPanel { Margin = new Thickness(0, 0, 0, 15), LastChildFill = true }; _fingerprint.Margin = new Thickness(0, 0, 12, 0); var probe = Btn("读取指纹", async () => await ProbeServer(), icon: "search"); DockPanel.SetDock(probe, Dock.Right); frow.Children.Add(probe); frow.Children.Add(_fingerprint); fields.Children.Add(frow);
            fields.Children.Add(new TextBlock { Text = "本机专用 SSH 公钥（私钥留在本机用户目录）", FontSize = 15, FontWeight = FontWeights.SemiBold, Foreground = Brush("#5B6981"), Margin = new Thickness(0, 14, 0, 5) });
            var keyrow = new DockPanel { Margin = new Thickness(0, 0, 0, 15), LastChildFill = true }; var copyKey = Btn("复制公钥", () => { if (!String.IsNullOrWhiteSpace(_publicKeyValue)) { Clipboard.SetText(_publicKeyValue); Toast("公钥已复制"); } }, icon: "copy"); DockPanel.SetDock(copyKey, Dock.Right); keyrow.Children.Add(copyKey); _publicKey = Input(); _publicKey.IsReadOnly = true; _publicKey.Height = 58; _publicKey.Margin = new Thickness(0, 0, 12, 0); keyrow.Children.Add(_publicKey); fields.Children.Add(keyrow);
            fields.Children.Add(new TextBlock { Text = "服务器需允许 SSH 反向转发，并由 Nginx / Caddy 将 HTTPS 请求转发到 127.0.0.1:43128。", FontSize = 14, TextWrapping = TextWrapping.Wrap, Foreground = Brush("#72809A"), Margin = new Thickness(0, 10, 0, 8) });
            _serverHint = new TextBlock { Text = "首次部署时，将公钥加入服务器的 localmcp 用户。", FontSize = 14, Foreground = Brush("#6B7A95"), TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 8) }; fields.Children.Add(_serverHint);
            _saveServer = Btn("保存服务器设置", async () => await SaveServerConfig(), icon: "save"); _saveServer.HorizontalAlignment = HorizontalAlignment.Left; fields.Children.Add(_saveServer);
            _serverFields.Child = fields; Body(card).Children.Add(_serverFields); target.Children.Add(card);
        }

        private void AddConnectionRadio(string title, string detail, string value, string tag)
        {
            var rb = new RadioButton { GroupName = "connection", Tag = value, IsChecked = value == "quick", Margin = new Thickness(0, 0, 0, 10), Padding = new Thickness(8), FontSize = 16, HorizontalContentAlignment = HorizontalAlignment.Stretch, VerticalContentAlignment = VerticalAlignment.Center };
            ApplyRadioTemplate(rb);
            var line = new DockPanel(); var chip = new Border { Background = Brush("#EEF2FC"), CornerRadius = new CornerRadius(8), Padding = new Thickness(8, 5, 8, 5), Child = new TextBlock { Text = tag, FontSize = 12, FontWeight = FontWeights.Bold, Foreground = Brush("#647BA3") } };
            DockPanel.SetDock(chip, Dock.Right); line.Children.Add(chip);
            var mark = new Border { Width = 38, Height = 38, CornerRadius = new CornerRadius(11), Background = Brush(value == "selfHosted" ? "#FCEBF0" : "#EAF0FC"), Margin = new Thickness(0, 0, 13, 0), Child = IconPath(value == "selfHosted" ? "server" : "cloud", Brush(value == "selfHosted" ? "#CE7893" : "#7188B9"), 19) };
            DockPanel.SetDock(mark, Dock.Left); line.Children.Add(mark);
            var text = new StackPanel { Margin = new Thickness(0, 0, 10, 0) }; text.Children.Add(new TextBlock { Text = title, FontWeight = FontWeights.SemiBold, FontSize = 16, Foreground = Brush("#32415D"), TextWrapping = TextWrapping.Wrap }); text.Children.Add(new TextBlock { Text = detail, FontSize = 14, Foreground = Brush("#72809B"), Margin = new Thickness(0, 2, 0, 0), TextWrapping = TextWrapping.Wrap }); line.Children.Add(text); rb.Content = line;
            rb.Checked += async (s, e) => { if (_binding) return; _connectionMode = value; _serverFields.Visibility = value == "selfHosted" ? Visibility.Visible : Visibility.Collapsed; try { await Post("/api/connection-mode", new Dictionary<string, object> { { "mode", value } }); } catch (Exception ex) { Toast(ex.Message); } };
            _connectionOptions.Children.Add(rb);
        }

        private void AddMainActions(Panel target)
        {
            var row = new DockPanel { Margin = new Thickness(0, 0, 0, 20), VerticalAlignment = VerticalAlignment.Center, LastChildFill = true };
            _connect = Btn("启动安全连接", async () => await Connect(), true, icon: "link"); _connect.MinWidth = 190; DockPanel.SetDock(_connect, Dock.Left); row.Children.Add(_connect);
            _stop = Btn("停止连接", async () => await StopConnection(), false, true, "stop"); _stop.Visibility = Visibility.Collapsed; DockPanel.SetDock(_stop, Dock.Left); row.Children.Add(_stop);
            _actionHint = new TextBlock { Text = "创建临时 HTTPS 隧道，不需要配置域名", FontSize = 15, Foreground = Brush("#677791"), VerticalAlignment = VerticalAlignment.Center, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(12, 8, 0, 8) }; row.Children.Add(_actionHint); target.Children.Add(row);
        }

        private void AddEndpointCard(Panel target)
        {
            var card = Card("连接到 ChatGPT", "复制 MCP 地址，在 ChatGPT 中添加自定义应用", "external-link");
            var row = new DockPanel { LastChildFill = true }; _mcpUrl = Input("连接成功后，MCP 地址会显示在这里"); _mcpUrl.IsReadOnly = true; _mcpUrl.Margin = new Thickness(0, 0, 12, 0); _copyUrl = Btn("复制地址", () => { if (!String.IsNullOrWhiteSpace(_mcpUrl.Text)) { Clipboard.SetText(_mcpUrl.Text); Toast("MCP 地址已复制"); } }, true, icon: "copy"); DockPanel.SetDock(_copyUrl, Dock.Right); row.Children.Add(_copyUrl); row.Children.Add(_mcpUrl); Body(card).Children.Add(row);
            Body(card).Children.Add(IconNote("alert", "地址含访问令牌，请勿公开分享。自有服务器模式下地址固定；断开时服务暂不可用，重连后恢复。", Brush("#A35E6B"), 16, 14, new Thickness(0, 15, 0, 18), 9));
            _resetLink = Btn("重置固定链接", async () => await ResetLink(), icon: "refresh"); _resetLink.HorizontalAlignment = HorizontalAlignment.Left; Body(card).Children.Add(_resetLink);
            var linkLine = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 20, 0, 8), Cursor = Cursors.Hand };
            linkLine.Children.Add(IconPath("external-link", Brush("#6F87B6"), 16));
            linkLine.Children.Add(new TextBlock { Text = "打开 ChatGPT 自定义应用设置", FontSize = 15, Foreground = Brush("#6F87B6"), Margin = new Thickness(8, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center });
            linkLine.MouseLeftButtonUp += (s, e) => Process.Start(new ProcessStartInfo("https://chatgpt.com/plugins") { UseShellExecute = true }); Body(card).Children.Add(linkLine);
            Body(card).Children.Add(new TextBlock { Text = "配置步骤：开启开发者模式 → Apps / Plugins → 创建自定义 MCP 应用 → 粘贴地址并扫描工具。", FontSize = 14, Foreground = Brush("#718099"), TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 8, 0, 0) });
            target.Children.Add(card);
        }

        private void AddToolsCard(Panel target)
        {
            var card = Card("本次开放工具", "权限变化会影响 Local MCP 与 REA 工具", "terminal"); _toolList = new TextBlock { Text = "正在读取工具…", FontSize = 15, Foreground = Brush("#596985"), TextWrapping = TextWrapping.Wrap, LineHeight = 25 }; Body(card).Children.Add(_toolList); target.Children.Add(card);
        }

        private void AddLogsCard(Panel target)
        {
            var card = Card("连接活动", "连接状态与工具调用记录", "activity");
            var head = new DockPanel(); _clearLogs = Btn("清空日志", async () => { try { await Post("/api/clear-logs", new Dictionary<string, object>()); _logList.Children.Clear(); Toast("日志已清空"); } catch (Exception ex) { Toast(ex.Message); } }, icon: "trash"); DockPanel.SetDock(_clearLogs, Dock.Right); head.Children.Add(_clearLogs); head.Children.Add(new TextBlock { Text = "实时记录", Foreground = Brush("#72809B"), FontSize = 14, VerticalAlignment = VerticalAlignment.Center }); Body(card).Children.Add(head);
            var logsScroll = new ScrollViewer { Height = 230, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Margin = new Thickness(0, 9, 0, 0) }; _logList = new StackPanel(); logsScroll.Content = _logList; Body(card).Children.Add(logsScroll); target.Children.Add(card);
        }

        private void BrowseFolder()
        {
            using (var d = new Forms.FolderBrowserDialog { Description = "选择要授权给 ChatGPT 的项目目录", ShowNewFolderButton = false, SelectedPath = _project.Text })
                if (d.ShowDialog() == Forms.DialogResult.OK) _project.Text = d.SelectedPath;
        }

        private async Task StartBackend()
        {
            try
            {
                var portProbe = new TcpListener(IPAddress.Loopback, 0); portProbe.Start(); int port = ((IPEndPoint)portProbe.LocalEndpoint).Port; portProbe.Stop(); _baseUrl = "http://127.0.0.1:" + port;
                var node = Path.Combine(_root, "runtime", "node.exe"); if (!File.Exists(node)) node = "node.exe";
                var start = new ProcessStartInfo(node, "\"" + Path.Combine(_root, "src", "main.js") + "\"") { WorkingDirectory = _root, UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden };
                start.EnvironmentVariables["WEXRUN_PORT"] = port.ToString(); start.EnvironmentVariables["WEXRUN_NO_BROWSER"] = "1"; start.EnvironmentVariables["WEXRUN_DESKTOP"] = "1";
                start.EnvironmentVariables["WEXRUN_DATA_DIR"] = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Local MCP Studio");
                _backend = Process.Start(start);
                var until = DateTime.UtcNow.AddSeconds(18); Exception last = null;
                while (DateTime.UtcNow < until)
                {
                    if (_backend == null || _backend.HasExited) throw new Exception("本机 MCP 服务未能启动。请检查程序目录和运行权限。");
                    try { await Get("/api/state"); return; } catch (Exception ex) { last = ex; await Task.Delay(250); }
                }
                throw new Exception("等待本机 MCP 服务启动超时。" + (last == null ? "" : " " + last.Message));
            }
            catch (Exception ex) { MessageBox.Show("Local MCP Studio 启动失败：\n\n" + ex.Message, "启动失败", MessageBoxButton.OK, MessageBoxImage.Error); Close(); }
        }

        private async Task Refresh()
        {
            if (_refreshing || _closing || _backend == null) return; _refreshing = true;
            try
            {
                var state = await Get("/api/state");
                _binding = true;
                if (String.IsNullOrWhiteSpace(_project.Text) && Val(state, "projectRoot") != null) _project.Text = Str(state, "projectRoot");
                _permission = Str(state, "permission", _permission); _connectionMode = Str(state, "connectionMode", _connectionMode);
                foreach (var rb in Descendants<RadioButton>(this))
                {
                    if (rb.GroupName == "permission") rb.IsChecked = Convert.ToString(rb.Tag) == _permission;
                    if (rb.GroupName == "connection") rb.IsChecked = Convert.ToString(rb.Tag) == _connectionMode;
                }
                UpdateDevNotice();
                _serverFields.Visibility = _connectionMode == "selfHosted" ? Visibility.Visible : Visibility.Collapsed;
                bool tunnel = Bool(state, "connected");
                _status.Text = tunnel ? (_connectionMode == "selfHosted" ? "自有服务器已连接" : "临时公网已连接") : "本机待连接";
                _status.Foreground = tunnel ? Brush("#527B62") : Brush("#53637D");
                _connect.Visibility = tunnel ? Visibility.Collapsed : Visibility.Visible; _stop.Visibility = tunnel ? Visibility.Visible : Visibility.Collapsed;
                _project.IsEnabled = !tunnel;
                foreach (var rb in Descendants<RadioButton>(this)) rb.IsEnabled = !tunnel;
                _mcpUrl.Text = Str(state, "mcpUrl"); _copyUrl.IsEnabled = !String.IsNullOrWhiteSpace(_mcpUrl.Text);
                _resetLink.Visibility = _connectionMode == "selfHosted" ? Visibility.Visible : Visibility.Collapsed;
                _actionHint.Text = tunnel ? "固定地址在线：" + Str(state, "tunnelUrl") : _connectionMode == "selfHosted" ? "启动后通过服务器固定地址连接本机" : "启动后自动创建临时 HTTPS 隧道";
                var localTools = Values(state, "tools");
                var toolSummary = "Local MCP 工具：" + localTools.Count + " 项";
                var rea = Val(state, "rea") as Dictionary<string, object>;
                if (rea != null && Bool(rea, "available"))
                {
                    var loadedReaCount = Convert.ToInt32(Val(rea, "loadedToolCount") ?? 0);
                    var reaCount = Convert.ToInt32(Val(rea, "toolCount") ?? loadedReaCount);
                    var reaStatus = loadedReaCount > 0 && Bool(rea, "running") ? "已加载" : _permission == "dev" ? "连接后加载" : "开发模式可用";
                    toolSummary += "\nREA " + Str(rea, "version") + "：" + reaCount + " 项（" + reaStatus + "）";
                }
                else if (rea != null) toolSummary += "\nREA MCP 未就绪：" + Str(rea, "error", "未找到运行时");
                _toolList.Text = toolSummary;
                RenderLogs(Values(state, "logs"));
                if (!_serverLoaded) await LoadServerConfig();
            }
            catch { }
            finally { _binding = false; _refreshing = false; }
        }

        private async Task LoadServerConfig()
        {
            try
            {
                var c = await Get("/api/server-config");
                _serverHost.Text = Str(c, "host"); _serverPort.Text = Str(c, "port", "22"); _serverUser.Text = Str(c, "username"); _serverUrl.Text = Str(c, "publicUrl");
                _fingerprint.Text = String.IsNullOrEmpty(Str(c, "hostFingerprint")) ? "" : "SHA256:" + Str(c, "hostFingerprint");
                _publicKeyValue = Str(c, "publicKey"); _publicKey.Text = _publicKeyValue;
                _serverHint.Text = Bool(c, "configured") ? "服务器设置已保存；隧道密钥已保存在本机。" : "读取 SSH 指纹并保存服务器设置后即可连接。"; _serverLoaded = true;
            }
            catch (Exception ex) { _serverHint.Text = ex.Message; }
        }

        private Dictionary<string, object> ServerBody()
        {
            int port = 22; Int32.TryParse(_serverPort.Text, out port); if (port < 1 || port > 65535) port = 22;
            string fingerprint = _fingerprint.Text.Trim(); if (fingerprint.StartsWith("SHA256:", StringComparison.OrdinalIgnoreCase)) fingerprint = fingerprint.Substring(7);
            return new Dictionary<string, object> { { "host", _serverHost.Text.Trim() }, { "port", port }, { "username", _serverUser.Text.Trim() }, { "publicUrl", _serverUrl.Text.Trim() }, { "hostFingerprint", fingerprint } };
        }

        private async Task SaveServerConfig()
        {
            try { var c = await Post("/api/server-config", ServerBody()); _serverHint.Text = Bool(c, "configured") ? "服务器设置已保存；隧道密钥已保存在本机。" : "已保存。"; _serverLoaded = true; Toast("自有服务器设置已保存"); await Refresh(); }
            catch (Exception ex) { Toast(ex.Message); }
        }

        private async Task ProbeServer()
        {
            try { int port; if (!Int32.TryParse(_serverPort.Text, out port)) port = 22; var c = await Post("/api/server-probe", new Dictionary<string, object> { { "host", _serverHost.Text.Trim() }, { "port", port } }); _fingerprint.Text = Str(c, "fingerprint"); _serverHint.Text = "请核对该指纹属于你的服务器，再保存设置。"; Toast("已读取 SSH 主机指纹"); }
            catch (Exception ex) { Toast(ex.Message); }
        }

        private async Task Connect()
        {
            string project = _project.Text.Trim(); if (String.IsNullOrWhiteSpace(project) || !Directory.Exists(project)) { Toast("请先选择有效的项目目录"); return; }
            try
            {
                _connect.IsEnabled = false;
                _connect.Content = _connectionMode == "selfHosted" ? "正在连接服务器…" : "正在准备 HTTPS 隧道…";
                _actionHint.Text = _connectionMode == "selfHosted" ? "正在通过 SSH 建立固定地址…" : "正在启动本地 MCP 服务并创建临时 HTTPS 地址…";
                if (_connectionMode == "selfHosted") await SaveServerConfig();
                var state = await Post("/api/connect", new Dictionary<string, object> { { "projectRoot", project }, { "permission", _permission }, { "connectionMode", _connectionMode } });
                _mcpUrl.Text = Str(state, "mcpUrl"); Toast("MCP 地址已就绪");
            }
            catch (Exception ex) { Toast(ex.Message); _actionHint.Text = ex.Message; }
            finally { _connect.Content = ButtonLabel("启动安全连接", "link", Brushes.White); _connect.IsEnabled = true; await Refresh(); }
        }

        private async Task StopConnection()
        {
            try { await Post("/api/disconnect", new Dictionary<string, object>()); Toast("连接已停止；稳定地址保持不变"); }
            catch (Exception ex) { Toast(ex.Message); }
            await Refresh();
        }

        private async Task ResetLink()
        {
            if (MessageBox.Show("重置后旧 MCP 地址会立即失效，ChatGPT 中已添加的连接需要替换为新地址。确定继续吗？", "重置固定链接", MessageBoxButton.YesNo, MessageBoxImage.Warning) != MessageBoxResult.Yes) return;
            try { var c = await Post("/api/reset-link", new Dictionary<string, object>()); _mcpUrl.Text = Str(c, "mcpUrl"); Toast("固定链接已重置；请更新 ChatGPT 连接"); await Refresh(); }
            catch (Exception ex) { Toast(ex.Message); }
        }

        private void RenderLogs(List<object> items)
        {
            if (_logList == null) return; _logList.Children.Clear();
            if (items.Count == 0) { var empty = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(4, 10, 4, 10) }; empty.Children.Add(IconPath("paw", Brush("#748BBD"), 17)); empty.Children.Add(new TextBlock { Text = "等待连接活动", FontSize = 15, Foreground = Brush("#8B818D"), Margin = new Thickness(7, 0, 0, 0) }); _logList.Children.Add(empty); return; }
            int start = Math.Max(0, items.Count - 80);
            for (int i = start; i < items.Count; i++)
            {
                var item = items[i] as Dictionary<string, object>; if (item == null) continue;
                string stamp = Str(item, "at"); DateTime dt; if (DateTime.TryParse(stamp, out dt)) stamp = dt.ToLocalTime().ToString("HH:mm:ss");
                var line = new TextBlock { Text = stamp + "   " + Str(item, "message"), FontSize = 14, Foreground = Str(item, "kind") == "error" ? Brush("#B65F6D") : Brush("#586883"), TextWrapping = TextWrapping.Wrap, Margin = new Thickness(2, 4, 2, 4) };
                _logList.Children.Add(line);
            }
        }

        private async Task<Dictionary<string, object>> Get(string path)
        {
            var response = await _http.GetAsync(_baseUrl + path); var text = await response.Content.ReadAsStringAsync(); if (!response.IsSuccessStatusCode) throw ApiError(text, response.StatusCode);
            return Json.Deserialize<Dictionary<string, object>>(text);
        }
        private async Task<Dictionary<string, object>> Post(string path, Dictionary<string, object> value)
        {
            var body = new StringContent(Json.Serialize(value), Encoding.UTF8, "application/json"); var response = await _http.PostAsync(_baseUrl + path, body); var text = await response.Content.ReadAsStringAsync();
            if (!response.IsSuccessStatusCode) throw ApiError(text, response.StatusCode); return Json.Deserialize<Dictionary<string, object>>(text);
        }
        private static Exception ApiError(string text, HttpStatusCode status)
        {
            try { return new Exception(Convert.ToString(Json.Deserialize<Dictionary<string, object>>(text)["error"])); } catch { return new Exception("请求失败：" + (int)status); }
        }
        private static object Val(Dictionary<string, object> d, string key) { object v; return d != null && d.TryGetValue(key, out v) ? v : null; }
        private static string Str(Dictionary<string, object> d, string key, string fallback = "") { var v = Val(d, key); return v == null ? fallback : Convert.ToString(v); }
        private static bool Bool(Dictionary<string, object> d, string key) { var v = Val(d, key); return v != null && Convert.ToBoolean(v); }
        private static List<object> Values(Dictionary<string, object> d, string key) { var a = Val(d, key) as ArrayList; if (a != null) return new List<object>(a.ToArray()); var b = Val(d, key) as object[]; return b == null ? new List<object>() : new List<object>(b); }
        private static IEnumerable<T> Descendants<T>(DependencyObject root) where T : DependencyObject
        {
            if (root == null) yield break;
            for (int i = 0; i < VisualTreeHelper.GetChildrenCount(root); i++) { var child = VisualTreeHelper.GetChild(root, i); if (child is T) yield return (T)child; foreach (var nested in Descendants<T>(child)) yield return nested; }
        }
        private void Toast(string message)
        {
            _toast.Text = message; _toastHost.Visibility = Visibility.Visible; _toastTimer?.Stop(); _toastTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(3) }; _toastTimer.Tick += (s, e) => { _toastHost.Visibility = Visibility.Collapsed; _toastTimer.Stop(); }; _toastTimer.Start();
        }
        private void StartTimer()
        {
            _timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1.5) }; _timer.Tick += async (s, e) => await Refresh(); _timer.Start();
        }
        private async void OnClosing(object sender, System.ComponentModel.CancelEventArgs e)
        {
            if (_shutdownComplete) return;
            e.Cancel = true;
            if (_closing) return;
            _closing = true; _timer?.Stop();
            try
            {
                using (var c = new HttpClient { Timeout = TimeSpan.FromSeconds(8) })
                {
                    var empty = new StringContent("{}", Encoding.UTF8, "application/json");
                    await c.PostAsync(_baseUrl + "/api/disconnect", empty);
                    await c.PostAsync(_baseUrl + "/api/shutdown", new StringContent("{}", Encoding.UTF8, "application/json"));
                }
            }
            catch { }
            try
            {
                if (_backend != null && !_backend.HasExited)
                    for (int i = 0; i < 40 && !_backend.HasExited; i++) await Task.Delay(100);
                if (_backend != null && !_backend.HasExited) _backend.Kill();
            }
            catch { }
            _http.Dispose(); _shutdownComplete = true; _closing = false; Close();
        }
    }
}
